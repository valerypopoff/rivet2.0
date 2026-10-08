import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { LRUCache } from 'lru-cache';
import { recordingWorkflowScopeClause } from '../routes/workflows/recording-workflow-scope.js';
import {
  recordingStatisticsCatalogSql,
  recordingStatisticsRowsSql,
  statisticsSqlRow,
  type RecordingStatisticsSqlRow,
} from '../routes/workflows/recording-statistics-sql.js';
import type {
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsSurface,
} from '../../../studio-server-shared/workflow-recording-types.js';

import { ImmutableLocalArtifactStore, type LocalArtifact } from './immutable-artifact-store.js';
import type { WorkflowRecordingExecutionIdentity } from '../../../studio-server-shared/workflow-recording-types.js';
import type { RuntimeLibraryManifest } from '../runtime-libraries/manifest.js';
import { decodeMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import type { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';
import { LocalUpgradeDiagnosticError } from './upgrade-diagnostics.js';
import type { WorkflowProjectReferenceSnapshot } from '../routes/workflows/project-reference-snapshots.js';
import { LocalWorkflowRouteClaims } from './workflow-route-claims.js';
import {
  getWorkflowProjectIndexDataFromContents,
  type WorkflowProjectIndexData,
} from '../routes/workflows/project-stats.js';

/** The complete project state preserved by conversion and normal local catalog writes. */
export type LocalWorkflowCatalogSnapshot = {
  workflowId: string;
  relativePath: string;
  name: string;
  fileName: string;
  updatedAt: string;
  contents: string;
  datasetsContents: string | null;
  endpointName: string;
  endpointAccess: 'public' | 'internal';
  endpointStatus: 'published' | 'unpublished_changes' | 'unpublished';
  publicationVersion: string;
  publishedEndpointName: string;
  publishedVersionId: string | null;
  lastPublishedAt: string | null;
  publishedContents: string | null;
  publishedDatasetsContents: string | null;
  publishedVersions: Array<{
    versionId: string;
    endpointName: string;
    publishedAt: string;
    isStarred: boolean;
    comment: string;
    contents: string;
    datasetsContents: string | null;
  }>;
  publishedWebApps: Array<{
    appId: string;
    uiGraphId: string;
    uiGraphName: string;
    slug: string;
    allowedEmails: string[];
    publishedAt: string;
    contents: string;
    datasetsContents: string | null;
  }>;
};

export type LocalRecordingCatalogSnapshot = {
  recordingId: string;
  workflowId: string;
  sourceProjectRelativePath: string;
  sourceProjectName: string;
  createdAt: string;
  runKind: 'published' | 'latest' | 'editor';
  status: 'succeeded' | 'failed' | 'suspicious';
  durationMs: number;
  endpointName: string;
  errorMessage: string | null;
  executionIdentity?: WorkflowRecordingExecutionIdentity;
  recordingContents: string;
  replayProjectContents: string;
  replayDatasetContents: string | null;
};

type ArtifactRef = LocalArtifact | null;
type ProjectTreeIndex = Pick<WorkflowProjectIndexData, 'revisionId' | 'stats'>;
export type LocalWorkflowTreeProject = Omit<
  LocalWorkflowCatalogSnapshot,
  | 'contents'
  | 'datasetsContents'
  | 'publishedContents'
  | 'publishedDatasetsContents'
  | 'publishedVersions'
  | 'publishedWebApps'
> &
  ProjectTreeIndex & {
    publishedWebApps: Array<
      Pick<
        LocalWorkflowCatalogSnapshot['publishedWebApps'][number],
        'uiGraphId' | 'uiGraphName' | 'slug' | 'allowedEmails' | 'publishedAt'
      > & { status: 'published' | 'unpublished_changes' }
    >;
  };
type StoredVersion = Omit<
  LocalWorkflowCatalogSnapshot['publishedVersions'][number],
  'contents' | 'datasetsContents'
> & {
  contents: ArtifactRef;
  datasetsContents: ArtifactRef;
};
type StoredWebApp = Omit<LocalWorkflowCatalogSnapshot['publishedWebApps'][number], 'contents' | 'datasetsContents'> & {
  contents: ArtifactRef;
  datasetsContents: ArtifactRef;
};
export type LocalPublicationState = StoredProject & {
  draftText: string;
  publishedVersions: StoredVersion[];
  publishedWebApps: StoredWebApp[];
};
type StoredProject = Omit<
  LocalWorkflowCatalogSnapshot,
  | 'contents'
  | 'datasetsContents'
  | 'publishedContents'
  | 'publishedDatasetsContents'
  | 'publishedVersions'
  | 'publishedWebApps'
> & {
  contents: ArtifactRef;
  datasetsContents: ArtifactRef;
  publishedContents: ArtifactRef;
  publishedDatasetsContents: ArtifactRef;
  /** Optional derived summary: older certified catalogs remain readable without rewriting them. */
  treeIndex?: ProjectTreeIndex;
};
type ProjectRow = {
  workflow_id: string;
  relative_path: string;
  endpoint_name: string;
  published_endpoint_name: string;
  metadata_json: string;
};
type VersionRow = { version_id: string; workflow_id: string; metadata_json: string };
type WebAppRow = { app_id: string; workflow_id: string; slug: string; metadata_json: string };
type RecordingRow = { recording_id: string; workflow_id: string; metadata_json: string };

type RecordingArtifactRef =
  | (LocalArtifact & ({ encoding?: undefined; decodedSize?: undefined } | { encoding: 'gzip'; decodedSize: number }))
  | null;
/** Migration retains the validated source encoding instead of expanding files. */
export type LocalRecordingSourceArtifact = { path: string; encoding: 'identity' | 'gzip'; decodedSize: number };
export type LocalRecordingSourceArtifacts = {
  recordingContents: LocalRecordingSourceArtifact;
  replayProjectContents: LocalRecordingSourceArtifact;
  replayDatasetContents: LocalRecordingSourceArtifact | null;
};
type RecordingCompressionOptions = { compression?: 'identity' | 'gzip'; gzipLevel?: number };
type StoredRecording = Omit<
  LocalRecordingCatalogSnapshot,
  'recordingContents' | 'replayProjectContents' | 'replayDatasetContents'
> & {
  recordingContents: RecordingArtifactRef;
  replayProjectContents: RecordingArtifactRef;
  replayDatasetContents: RecordingArtifactRef;
};
export type LocalRecordingMetadata = Omit<
  LocalRecordingCatalogSnapshot,
  'recordingContents' | 'replayProjectContents' | 'replayDatasetContents'
> & {
  recordingHash: string;
  recordingBytes: number;
  projectBytes: number;
  datasetBytes: number;
  recordingDecodedBytes: number;
  projectDecodedBytes: number;
  datasetDecodedBytes: number;
  hasReplayDataset: boolean;
};
type StoredProjectBundle = { project: StoredProject; versions: StoredVersion[]; apps: StoredWebApp[] };
export type LocalWorkflowProjectPayload = Omit<LocalWorkflowTreeProject, 'revisionId' | 'stats'> & {
  contents: string | null;
  datasetsContents: string | null;
  publishedAt: string | null;
};
export type LocalRuntimeLibraryState = { manifest: RuntimeLibraryManifest; archive: Buffer | null };
export type LocalExecutionSelection =
  | { endpointName: string; version: 'latest' | 'published' }
  | { workflowId: string; version: 'latest' | 'published' }
  | { webAppSlug: string; version: 'latest' | 'published' };
export type LocalExecutionSnapshot = {
  workflowId: string;
  relativePath: string;
  endpointAccess: 'public' | 'internal';
  contents: string;
  datasetsContents: string | null;
  webApp?: Omit<StoredWebApp, 'contents' | 'datasetsContents'>;
  cacheStatus?: 'hit' | 'miss' | 'bypass';
};
export type LocalCatalogChange = {
  before: LocalWorkflowCatalogSnapshot | null;
  after: LocalWorkflowCatalogSnapshot | null;
};
type StoredRuntimeLibraryState = { manifest: RuntimeLibraryManifest; archive: ArtifactRef };

const APPLICATION_ID = 0x52495643; // RIVC; separate candidate DB from the App Settings candidate.
const SCHEMA_VERSION = 4;
const supportedSchemaVersion = (version: number) => [2, 3, SCHEMA_VERSION].includes(version);
const LEGACY_ENDPOINT_INDEX =
  "CREATE UNIQUE INDEX projects_endpoint_name_unique ON projects(endpoint_name) WHERE endpoint_name <> ''";
// A saved preference is not a route reservation after the endpoint is unpublished.
const ENDPOINT_INDEX = `${LEGACY_ENDPOINT_INDEX} AND json_extract(metadata_json, '$.publishedContents') IS NOT NULL`;
const LEGACY_WEB_APPS_TABLE = `CREATE TABLE web_apps (
  app_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL
)`;
const WEB_APPS_TABLE = `CREATE TABLE web_apps (
  app_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(workflow_id, app_id)
)`;
const SCHEMA = `
CREATE TABLE folders (path TEXT PRIMARY KEY);
CREATE TABLE projects (
  workflow_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  endpoint_name TEXT NOT NULL,
  published_endpoint_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
${ENDPOINT_INDEX};
CREATE UNIQUE INDEX projects_published_endpoint_name_unique ON projects(published_endpoint_name) WHERE published_endpoint_name <> '';
CREATE TABLE published_versions (
  version_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL
);
${WEB_APPS_TABLE};
CREATE TABLE recordings (
  recording_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL
);
CREATE INDEX recordings_workflow_created_at ON recordings(workflow_id, json_extract(metadata_json, '$.createdAt'));
CREATE TABLE runtime_library_state (
  slot TEXT PRIMARY KEY CHECK(slot = 'default'),
  metadata_json TEXT NOT NULL
);
`;

const SCHEMA_STATEMENTS = SCHEMA.split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The recording encoding marker was historically advanced without changing DDL.
 * Recognize only complete known schemas, including legacy DDL marked as v4.
 * Reads must not rewrite certified candidates. Writers migrate inside their
 * existing transaction, even when the marker already says v4. */
function readCatalogSchema(db: DatabaseSync): 'legacy' | 'current' {
  db.exec('SAVEPOINT catalog_schema_check');
  try {
    const identity = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
    if (identity !== APPLICATION_ID) throw new Error('Local workflow catalog has an unsupported database identity.');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (!supportedSchemaVersion(version)) throw new Error('Local workflow catalog has an unsupported schema version.');
    const objects = db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").all() as Array<{
      name: string;
      sql: string;
    }>;
    const actual = new Map(objects.map(({ name, sql }) => [name, normalizedSql(sql)]));
    const legacy = actual.get('projects_endpoint_name_unique') === normalizedSql(LEGACY_ENDPOINT_INDEX);
    if (!legacy && version !== SCHEMA_VERSION) {
      throw new Error('Local workflow catalog schema does not match its version.');
    }
    for (const currentStatement of SCHEMA_STATEMENTS) {
      const statement = !legacy
        ? currentStatement
        : currentStatement === ENDPOINT_INDEX
          ? LEGACY_ENDPOINT_INDEX
          : currentStatement === WEB_APPS_TABLE
            ? LEGACY_WEB_APPS_TABLE
            : currentStatement;
      const name = /\b(?:TABLE|INDEX) ([a-z_]+)/.exec(statement)?.[1];
      if (!name) throw new Error('Local workflow catalog has an invalid expected schema.');
      if (actual.get(name) !== normalizedSql(statement)) {
        throw new Error(`Local workflow catalog schema is incompatible at ${name}.`);
      }
    }
    if (actual.size !== SCHEMA_STATEMENTS.length) {
      throw new Error('Local workflow catalog schema contains unexpected objects.');
    }
    db.exec('RELEASE catalog_schema_check');
    return legacy ? 'legacy' : 'current';
  } catch (error) {
    db.exec('ROLLBACK TO catalog_schema_check; RELEASE catalog_schema_check');
    throw error;
  }
}

function comparableJson(value: unknown): unknown {
  // Catalog snapshots are JSON data. Match persisted omission of optional
  // undefined fields without serializing large artifact strings a second time.
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(comparableJson);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, comparableJson(field)]),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(comparableJson(left), comparableJson(right));
}

function assertPath(value: string, kind: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid local ${kind} path: ${value}`);
  }
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && !!value.trim();
}

function validRoute(value: unknown, allowEmpty = false): boolean {
  return typeof value === 'string' && ((allowEmpty && value === '') || /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value));
}

function assertProjectMetadata(project: StoredProject | LocalWorkflowCatalogSnapshot): void {
  if (!project || typeof project !== 'object') throw new Error('Invalid local project metadata.');
  assertPath(project.relativePath, 'project');
  if (
    !nonempty(project.workflowId) ||
    !project.relativePath.endsWith('.rivet-project') ||
    project.fileName !== path.posix.basename(project.relativePath) ||
    project.name !== path.posix.basename(project.relativePath, '.rivet-project') ||
    typeof project.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(project.updatedAt)) ||
    !['public', 'internal'].includes(project.endpointAccess) ||
    !['published', 'unpublished_changes', 'unpublished'].includes(project.endpointStatus) ||
    !validRoute(project.endpointName, true) ||
    !validRoute(project.publishedEndpointName, true) ||
    typeof project.publicationVersion !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(project.publicationVersion) ||
    (project.publishedVersionId !== null && !nonempty(project.publishedVersionId)) ||
    (project.lastPublishedAt !== null &&
      (typeof project.lastPublishedAt !== 'string' || !Number.isFinite(Date.parse(project.lastPublishedAt))))
  )
    throw new Error('Invalid local project metadata or access policy.');
}

function assertVersionMetadata(
  version: StoredVersion | LocalWorkflowCatalogSnapshot['publishedVersions'][number],
): void {
  if (
    !version ||
    !nonempty(version.versionId) ||
    !validRoute(version.endpointName) ||
    typeof version.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(version.publishedAt)) ||
    typeof version.isStarred !== 'boolean' ||
    typeof version.comment !== 'string'
  )
    throw new Error('Invalid local publication metadata.');
}

function assertWebAppMetadata(app: StoredWebApp | LocalWorkflowCatalogSnapshot['publishedWebApps'][number]): void {
  if (
    !app ||
    !nonempty(app.appId) ||
    !nonempty(app.uiGraphId) ||
    typeof app.uiGraphName !== 'string' ||
    !validRoute(app.slug) ||
    app.slug.toLowerCase() === 'auth' ||
    typeof app.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(app.publishedAt)) ||
    !Array.isArray(app.allowedEmails) ||
    app.allowedEmails.some((email) => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  )
    throw new Error('Invalid local web-app metadata or access policy.');
}

function assertArtifactReference(ref: ArtifactRef): void {
  if (ref !== null && (!ref || !/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.size) || ref.size < 0))
    throw new Error('Local catalog contains an invalid artifact reference.');
}

function assertPublicationPointer<T>(
  owner: {
    publishedEndpointName: string;
    publishedVersionId: string | null;
    publishedContents: T;
    publishedDatasetsContents: T;
  },
  versions: Array<{ versionId: string; endpointName: string; contents: T; datasetsContents: T }>,
  apps: Array<{ uiGraphId: string }>,
): void {
  if (owner.publishedEndpointName && owner.publishedContents === null)
    throw new Error('Local catalog published endpoint is missing its snapshot.');
  if (owner.publishedContents === null && owner.publishedDatasetsContents !== null)
    throw new Error('Local catalog published datasets have no project snapshot.');
  if (owner.publishedVersionId) {
    const current = versions.find((version) => version.versionId === owner.publishedVersionId);
    if (!current) throw new Error('Local catalog current publication points to a missing version.');
    if (
      current.endpointName !== owner.publishedEndpointName ||
      !sameJson(current.contents, owner.publishedContents) ||
      !sameJson(current.datasetsContents, owner.publishedDatasetsContents)
    )
      throw new Error('Local catalog current publication pointer is inconsistent.');
  }
  if (new Set(apps.map((app) => app.uiGraphId)).size !== apps.length)
    throw new Error('Local catalog contains duplicate web-app graph bindings.');
}

function projectTreeIndex(contents: string, datasetsContents: string | null): ProjectTreeIndex {
  const { revisionId, stats } = getWorkflowProjectIndexDataFromContents(contents, datasetsContents);
  return { revisionId, stats };
}

function assertTreeIndex(index: ProjectTreeIndex | undefined): void {
  if (index === undefined) return;
  if (
    !index ||
    typeof index.revisionId !== 'string' ||
    !/^fs-sha256:[a-f0-9]{64}$/.test(index.revisionId) ||
    !index.stats ||
    ![index.stats.graphCount, index.stats.totalNodeCount, index.stats.webAppCount].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
    throw new Error('Invalid local project tree index.');
}

/** Derived summaries are not part of the editable snapshot or its CAS authority. */
function sameProjectBundle(left: StoredProjectBundle | null, right: StoredProjectBundle | null): boolean {
  if (!left || !right) return left === right;
  const { treeIndex: _leftIndex, ...leftProject } = left.project;
  const { treeIndex: _rightIndex, ...rightProject } = right.project;
  return sameJson({ ...left, project: leftProject }, { ...right, project: rightProject });
}

function sameArtifactReference(left: ArtifactRef, right: ArtifactRef): boolean {
  return left === null || right === null ? left === right : left.hash === right.hash && left.size === right.size;
}

function storedProject(row: ProjectRow): StoredProject {
  const project = JSON.parse(row.metadata_json) as StoredProject;
  assertProjectMetadata(project);
  assertTreeIndex(project.treeIndex);
  for (const ref of [
    project.contents,
    project.datasetsContents,
    project.publishedContents,
    project.publishedDatasetsContents,
  ])
    assertArtifactReference(ref);
  if (
    project.workflowId !== row.workflow_id ||
    project.relativePath !== row.relative_path ||
    project.endpointName !== row.endpoint_name ||
    project.publishedEndpointName !== row.published_endpoint_name ||
    project.contents === null
  )
    throw new Error(`Local catalog project row is inconsistent: ${row.relative_path}`);
  return project;
}

function storedVersion(row: VersionRow): StoredVersion {
  const version = JSON.parse(row.metadata_json) as StoredVersion;
  assertVersionMetadata(version);
  for (const ref of [version.contents, version.datasetsContents]) assertArtifactReference(ref);
  if (version.versionId !== row.version_id || version.contents === null)
    throw new Error('Local catalog version row is inconsistent.');
  return version;
}

function storedWebApp(row: WebAppRow): StoredWebApp {
  const app = JSON.parse(row.metadata_json) as StoredWebApp;
  assertWebAppMetadata(app);
  for (const ref of [app.contents, app.datasetsContents]) assertArtifactReference(ref);
  if (app.appId !== row.app_id || app.slug !== row.slug || app.contents === null)
    throw new Error('Local catalog web-app row is inconsistent.');
  return app;
}

function projectTreeMetadata(project: StoredProject, apps: StoredWebApp[]) {
  const {
    contents,
    datasetsContents,
    publishedContents: _published,
    publishedDatasetsContents: _datasets,
    treeIndex: _index,
    ...metadata
  } = project;
  return {
    ...metadata,
    publishedWebApps: apps.map(({ contents: appContents, datasetsContents: appDatasets, ...app }) => {
      const { appId: _id, ...summary } = app;
      return {
        ...summary,
        status:
          sameArtifactReference(contents, appContents) && sameArtifactReference(datasetsContents, appDatasets)
            ? ('published' as const)
            : ('unpublished_changes' as const),
      };
    }),
  };
}

function assertProjectSnapshot(snapshot: LocalWorkflowCatalogSnapshot): void {
  assertProjectMetadata(snapshot);
  if (
    typeof snapshot.contents !== 'string' ||
    (snapshot.datasetsContents !== null && typeof snapshot.datasetsContents !== 'string') ||
    (snapshot.publishedContents !== null && typeof snapshot.publishedContents !== 'string') ||
    (snapshot.publishedDatasetsContents !== null && typeof snapshot.publishedDatasetsContents !== 'string') ||
    !Array.isArray(snapshot.publishedVersions) ||
    !Array.isArray(snapshot.publishedWebApps)
  )
    throw new Error('Invalid local project artifacts.');
  for (const version of snapshot.publishedVersions) {
    assertVersionMetadata(version);
    if (
      typeof version.contents !== 'string' ||
      (version.datasetsContents !== null && typeof version.datasetsContents !== 'string')
    )
      throw new Error('Invalid local publication artifacts.');
  }
  for (const app of snapshot.publishedWebApps) {
    assertWebAppMetadata(app);
    if (typeof app.contents !== 'string' || (app.datasetsContents !== null && typeof app.datasetsContents !== 'string'))
      throw new Error('Invalid local web-app artifacts.');
  }
  assertPublicationPointer(snapshot, snapshot.publishedVersions, snapshot.publishedWebApps);
}

async function putText(store: ImmutableLocalArtifactStore, contents: string | null): Promise<ArtifactRef> {
  return contents === null ? null : store.putBytes(Buffer.from(contents));
}

function hashText(contents: string | null): ArtifactRef {
  const bytes = contents === null ? null : Buffer.from(contents);
  return bytes === null ? null : { hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

async function readText(store: ImmutableLocalArtifactStore, ref: ArtifactRef): Promise<string | null> {
  const bytes = await readBytes(store, ref);
  return bytes === null ? null : decodeMigrationSourceUtf8(bytes, `local catalog artifact ${ref!.hash}`);
}

async function readBytes(store: ImmutableLocalArtifactStore, ref: ArtifactRef): Promise<Buffer | null> {
  assertArtifactReference(ref);
  if (ref === null) return null;
  return store.read(ref.hash, ref.size);
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function isRecordingTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function assertRecordingArtifactReference(ref: RecordingArtifactRef): void {
  assertArtifactReference(ref);
  if (ref === null) return;
  if (
    (ref.encoding !== undefined && ref.encoding !== 'gzip') ||
    (ref.encoding === 'gzip'
      ? !Number.isSafeInteger(ref.decodedSize) || ref.decodedSize < 0
      : ref.decodedSize !== undefined)
  )
    throw new Error('Invalid local recording artifact encoding or decoded size.');
}
async function readRecordingText(
  store: ImmutableLocalArtifactStore,
  ref: RecordingArtifactRef,
): Promise<string | null> {
  assertRecordingArtifactReference(ref);
  if (ref === null) return null;
  const bytes = await store.read(ref.hash, ref.size);
  const decoded =
    ref.encoding === 'gzip' ? await gunzipAsync(bytes, { maxOutputLength: Math.max(1, ref.decodedSize) }) : bytes;
  if (decoded.length !== (ref.decodedSize ?? ref.size))
    throw new Error('Local recording artifact has an unexpected decoded size.');
  return decodeMigrationSourceUtf8(decoded, `local recording artifact ${ref.hash}`);
}
async function putRecordingText(
  store: ImmutableLocalArtifactStore,
  contents: string | null,
  source?: LocalRecordingSourceArtifact | null,
  options: RecordingCompressionOptions = {},
): Promise<RecordingArtifactRef> {
  if (contents === null) {
    if (source) throw new Error('Unexpected recording source artifact.');
    return null;
  }
  const decodedSize = Buffer.byteLength(contents);
  if (source) {
    if (!['identity', 'gzip'].includes(source.encoding) || source.decodedSize !== decodedSize)
      throw new Error('Recording source artifact differs from decoded contents.');
    const stored = await store.putFile(source.path);
    const ref = source.encoding === 'gzip' ? { ...stored, encoding: 'gzip' as const, decodedSize } : stored;
    // Verify the bytes copied, not only the earlier source scan. The immutable
    // store checks file identity during publication; semantic equality catches
    // a source replacement between scan and publication, including UTF-8/BOM.
    if ((await readRecordingText(store, ref)) !== contents)
      throw new Error('Recording source artifact changed before publication.');
    return ref;
  }
  const bytes = Buffer.from(contents);
  if (options.compression === 'identity') return store.putBytes(bytes);
  const compressed = await gzipAsync(bytes, { level: options.gzipLevel ?? 4 });
  return compressed.length < bytes.length
    ? { ...(await store.putBytes(compressed)), encoding: 'gzip', decodedSize }
    : store.putBytes(bytes);
}

function sameArchive(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function assertRuntimeLibraryState(state: LocalRuntimeLibraryState): void {
  const manifest = state.manifest;
  if (
    !manifest ||
    !manifest.packages ||
    typeof manifest.packages !== 'object' ||
    Array.isArray(manifest.packages) ||
    typeof manifest.updatedAt !== 'string' ||
    (manifest.activeReleaseId !== undefined &&
      (typeof manifest.activeReleaseId !== 'string' || !manifest.activeReleaseId.trim())) ||
    (state.archive !== null && !Buffer.isBuffer(state.archive))
  ) {
    throw new Error('Local catalog runtime-library state is invalid.');
  }
  for (const [name, entry] of Object.entries(manifest.packages)) {
    if (!name || !entry || entry.name !== name || typeof entry.version !== 'string' || !entry.version.trim()) {
      throw new Error('Local catalog runtime-library package entry is invalid.');
    }
  }
  if (Object.keys(manifest.packages).length > 0 !== (state.archive !== null)) {
    throw new Error('Local catalog runtime-library archive does not match package state.');
  }
}

/** Immutable-artifact catalog for candidate verification and selected SQLite serving. */
export class LocalWorkflowCatalog {
  readonly #databasePath: string;
  readonly #artifacts: ImmutableLocalArtifactStore;
  #db: DatabaseSync | null = null;
  #readOnly = false;
  readonly #treeIndexes = new LRUCache<string, Promise<ProjectTreeIndex>>({ max: 1024 });
  #collectionCursor = '';

  constructor(options: { databasePath: string; artifactRoot: string }) {
    this.#databasePath = options.databasePath;
    this.#artifacts = new ImmutableLocalArtifactStore(options.artifactRoot);
  }

  initialize(options: { verifyOnly?: boolean; requireExisting?: boolean } = {}): void {
    const readOnly = options.verifyOnly ?? false;
    if (this.#db) {
      if (this.#readOnly !== readOnly) throw new Error('Local workflow catalog is already open in another mode.');
      return;
    }
    if ((readOnly || options.requireExisting) && !existsSync(this.#databasePath)) {
      throw new Error('Local workflow catalog candidate does not exist.');
    }
    if (!readOnly) mkdirSync(path.dirname(this.#databasePath), { recursive: true, mode: 0o700 });
    if (existsSync(this.#databasePath)) {
      const stat = lstatSync(this.#databasePath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error('Local workflow catalog path must be a regular file.');
    }
    const db = new DatabaseSync(this.#databasePath, { readOnly });
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
      const identity = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (identity === 0 && version === 0 && !readOnly && !options.requireExisting) {
        const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get();
        if (existing) throw new Error('Local workflow catalog path contains an unidentified database.');
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
        try {
          db.exec(SCHEMA);
          db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } else if (identity !== APPLICATION_ID || !supportedSchemaVersion(version)) {
        throw new Error('Local workflow catalog has an unsupported database identity or schema version.');
      }
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrity.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
        throw new Error('Local workflow catalog failed SQLite integrity checks.');
      }
      readCatalogSchema(db);
      this.#validateRoutes(db);
      // Reject incompatible existing databases before changing persistent pragmas.
      if (!readOnly) {
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
        chmodSync(this.#databasePath, 0o600);
      }
      this.#db = db;
      this.#readOnly = readOnly;
    } catch (error) {
      this.#db = null;
      db.close();
      throw error;
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#readOnly = false;
    this.#treeIndexes.clear();
  }

  checkHealth(): void {
    const db = this.#database();
    // Integrity/schema validation is performed on initialize. Readiness only
    // proves this open authority is responsive; do not scan every row each poll.
    readCatalogSchema(db);
    db.prepare('SELECT 1 FROM projects LIMIT 1').get();
  }

  checkIntegrity(): void {
    const db = this.#database();
    readCatalogSchema(db);
    const integrity = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
      throw new Error('Local workflow catalog failed its health check.');
  }

  #database(): DatabaseSync {
    if (!this.#db) throw new Error('Local workflow catalog is not initialized.');
    return this.#db;
  }

  /** Synchronous metadata snapshot only: never hold a SQLite read lock across file I/O.
   * Savepoints also work inside mutation transactions and nested metadata reads. */
  #readMetadata<T>(read: (db: DatabaseSync) => T): T {
    const db = this.#database();
    db.exec('SAVEPOINT local_metadata_read');
    try {
      const result = read(db);
      db.exec('RELEASE local_metadata_read');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO local_metadata_read; RELEASE local_metadata_read');
      throw error;
    }
  }

  /** Called inside the caller's write transaction; failed writes roll this back too. */
  #upgradeSchema(db: DatabaseSync): void {
    if (readCatalogSchema(db) === 'current') return;
    db.exec(`DROP INDEX projects_endpoint_name_unique; ${ENDPOINT_INDEX};
      ALTER TABLE web_apps RENAME TO legacy_web_apps;
      ${WEB_APPS_TABLE};
      INSERT INTO web_apps(rowid, app_id, workflow_id, slug, metadata_json)
        SELECT rowid, app_id, workflow_id, slug, metadata_json FROM legacy_web_apps;
      DROP TABLE legacy_web_apps;
      PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  #validateRoutes(db: DatabaseSync): void {
    const routes = new LocalWorkflowRouteClaims();
    for (const row of db
      .prepare(
        `SELECT workflow_id, endpoint_name, published_endpoint_name FROM projects
        WHERE json_extract(metadata_json, '$.publishedContents') IS NOT NULL`,
      )
      .all() as ProjectRow[]) {
      for (const name of [row.endpoint_name, row.published_endpoint_name]) routes.endpoint(row.workflow_id, name);
    }
    for (const row of db.prepare('SELECT slug FROM web_apps').all() as WebAppRow[]) {
      routes.webApp(row.slug);
    }
  }

  importFolder(folderPath: string): void {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    assertPath(folderPath, 'folder');
    this.#database().prepare('INSERT OR IGNORE INTO folders(path) VALUES (?)').run(folderPath);
  }

  listFolders(): string[] {
    return (this.#database().prepare('SELECT path FROM folders').all() as Array<{ path: string }>)
      .map((row) => row.path)
      .sort((left, right) => left.localeCompare(right));
  }

  listProjectPaths(): string[] {
    return (this.#database().prepare('SELECT relative_path FROM projects').all() as ProjectRow[])
      .map((row) => row.relative_path)
      .sort((left, right) => left.localeCompare(right));
  }

  /** A consistent metadata-only view. No historical bodies or recording rows belong in tree reads. */
  #treeMetadata() {
    return this.#readMetadata((db) => {
      const folders = this.listFolders();
      const rows = db
        .prepare(
          `
        SELECT projects.*, current_version.version_id AS current_version_id,
          current_version.metadata_json AS current_version_json
        FROM projects LEFT JOIN published_versions AS current_version
          ON current_version.version_id = json_extract(projects.metadata_json, '$.publishedVersionId')
          AND current_version.workflow_id = projects.workflow_id
        ORDER BY projects.relative_path
      `,
        )
        .all() as Array<ProjectRow & { current_version_id: string | null; current_version_json: string | null }>;
      const appRows = db.prepare('SELECT * FROM web_apps ORDER BY workflow_id, rowid').all() as WebAppRow[];
      const stamp = createHash('sha256').update(JSON.stringify({ folders, rows, appRows })).digest('hex');
      return { folders, rows, appRows, stamp };
    });
  }

  /** Tree-only stamp: recording traffic and unrelated publication history do not invalidate it. */
  changeStamp(): string {
    return this.#treeMetadata().stamp;
  }

  #treeIndex(project: StoredProject): Promise<ProjectTreeIndex> {
    if (project.treeIndex) return Promise.resolve(project.treeIndex);
    const key = JSON.stringify([project.contents, project.datasetsContents]);
    const cached = this.#treeIndexes.get(key);
    if (cached) return cached;
    // Legacy catalogs need only their current draft, once per immutable revision.
    // Sharing promises also coalesces simultaneous browser reloads; failures are retryable.
    const pending = (async () => {
      const contents = await readText(this.#artifacts, project.contents);
      const datasets = await readText(this.#artifacts, project.datasetsContents);
      return projectTreeIndex(contents!, datasets);
    })().catch((error: unknown) => {
      if (this.#treeIndexes.peek(key) === pending) this.#treeIndexes.delete(key);
      throw error;
    });
    this.#treeIndexes.set(key, pending);
    return pending;
  }

  async readTreeProjection(): Promise<{ folders: string[]; projects: LocalWorkflowTreeProject[]; stamp: string }> {
    const { folders, rows, appRows, stamp } = this.#treeMetadata();
    const apps = new Map<string, StoredWebApp[]>();
    const owners = new Set(rows.map((row) => row.workflow_id));
    for (const row of appRows) {
      if (!owners.has(row.workflow_id)) throw new Error('Local catalog web-app owner is missing.');
      const list = apps.get(row.workflow_id) ?? [];
      list.push(storedWebApp(row));
      apps.set(row.workflow_id, list);
    }
    const projects = rows
      .map((row) => {
        const project = storedProject(row);
        const webApps = apps.get(row.workflow_id) ?? [];
        const current =
          row.current_version_json === null
            ? []
            : [
                storedVersion({
                  version_id: row.current_version_id!,
                  workflow_id: row.workflow_id,
                  metadata_json: row.current_version_json,
                }),
              ];
        assertPublicationPointer(project, current, webApps);
        // Capture this snapshot's cache hits before misses start evicting them.
        // A tree larger than the cache must not reread every body in scan order.
        const cachedIndex = project.treeIndex
          ? undefined
          : this.#treeIndexes.get(JSON.stringify([project.contents, project.datasetsContents]));
        return { project, webApps, cachedIndex };
      })
      .sort((left, right) => left.project.relativePath.localeCompare(right.project.relativePath));
    const result: LocalWorkflowTreeProject[] = new Array(projects.length);
    let cursor = 0;
    let stopped = false;
    // Bound cold legacy reads instead of opening every project simultaneously.
    // Drain already-started reads even on failure; don't leave background workers
    // populating a cache after the request has failed or its owner has closed.
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(8, projects.length) }, async () => {
        while (!stopped && cursor < projects.length) {
          const index = cursor++;
          const { project, webApps, cachedIndex } = projects[index]!;
          let summary: ProjectTreeIndex;
          try {
            summary = await (cachedIndex ?? this.#treeIndex(project));
          } catch (error) {
            stopped = true;
            throw error;
          }
          result[index] = {
            ...projectTreeMetadata(project, webApps),
            ...summary,
            // Each reader owns its output; cached legacy summaries are immutable.
            stats: { ...summary.stats },
          };
        }
      }),
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return { folders, projects: result, stamp };
  }

  listRecordingIds(): string[] {
    return (this.#database().prepare('SELECT recording_id FROM recordings').all() as RecordingRow[])
      .map((row) => row.recording_id)
      .sort((left, right) => left.localeCompare(right));
  }

  readMigrationCounts(): {
    projects: number;
    folders: number;
    recordingBundles: number;
    publishedEndpoints: number;
    publishedWebApps: number;
    publishedVersions: number;
  } {
    return this.#database()
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM folders) AS folders,
      (SELECT COUNT(*) FROM recordings) AS recordingBundles,
      (SELECT COUNT(*) FROM projects WHERE published_endpoint_name != '') AS publishedEndpoints,
      (SELECT COUNT(*) FROM web_apps) AS publishedWebApps,
      (SELECT COUNT(*) FROM published_versions) AS publishedVersions`,
      )
      .get() as ReturnType<LocalWorkflowCatalog['readMigrationCounts']>;
  }

  findProjectPathById(workflowId: string): string | null {
    const row = this.#database().prepare('SELECT relative_path FROM projects WHERE workflow_id = ?').get(workflowId) as
      | { relative_path: string }
      | undefined;
    return row?.relative_path ?? null;
  }

  #executionBundle(selection: LocalExecutionSelection): { bundle: StoredProjectBundle; app?: StoredWebApp } | null {
    return this.#readMetadata((db) => {
      let row: { relative_path: string } | undefined;
      if ('workflowId' in selection) {
        row = db
          .prepare('SELECT relative_path FROM projects WHERE workflow_id = ?')
          .get(selection.workflowId) as typeof row;
      } else if ('endpointName' in selection) {
        const column = selection.version === 'published' ? 'published_endpoint_name' : 'endpoint_name';
        row = db
          .prepare(
            `SELECT relative_path FROM projects WHERE ${column} = ? COLLATE NOCASE AND ${column} <> ''
          AND json_extract(metadata_json, '$.publishedContents') IS NOT NULL`,
          )
          .get(selection.endpointName) as typeof row;
      } else {
        row = db
          .prepare(
            `SELECT projects.relative_path FROM projects JOIN web_apps USING(workflow_id)
        WHERE web_apps.slug = ? COLLATE NOCASE`,
          )
          .get(selection.webAppSlug) as typeof row;
      }
      if (!row) return null;
      const bundle = this.#readStoredProjectBundle(row.relative_path, false)!;
      const app =
        'webAppSlug' in selection
          ? bundle.apps.find((app) => app.slug.toLowerCase() === selection.webAppSlug.toLowerCase())
          : undefined;
      if ('webAppSlug' in selection && !app) throw new Error('Local catalog web-app lookup is inconsistent.');
      return { bundle, ...(app ? { app } : {}) };
    });
  }

  /** Route/policy lookup never reads unrelated projects or old history blobs. */
  readWebAppPolicy(slug: string): Omit<LocalExecutionSnapshot, 'contents' | 'datasetsContents'> | null {
    const match = this.#executionBundle({ webAppSlug: slug, version: 'published' });
    if (!match?.app) return null;
    const { contents: _contents, datasetsContents: _datasets, ...webApp } = match.app;
    return {
      workflowId: match.bundle.project.workflowId,
      relativePath: match.bundle.project.relativePath,
      endpointAccess: match.bundle.project.endpointAccess,
      webApp,
    };
  }

  async readExecutionSource(
    selection: LocalExecutionSelection,
    cache?: Pick<ManagedWorkflowExecutionCache, 'getRevisionMaterialization' | 'setRevisionMaterialization'>,
  ): Promise<LocalExecutionSnapshot | null> {
    selection = structuredClone(selection);
    const match = this.#executionBundle(selection);
    if (!match) return null;
    const project = match.bundle.project;
    const source =
      selection.version === 'latest'
        ? project
        : match.app ?? {
            contents: project.publishedContents,
            datasetsContents: project.publishedDatasetsContents,
          };
    if (!source.contents) return null;
    // Only immutable, checksum-verified content is cached. The route, path and
    // access policy are resolved from SQL on every call, including cache hits.
    const revisionId = `local:${source.contents.hash}:${source.contents.size}:${source.datasetsContents?.hash ?? 'none'}:${source.datasetsContents?.size ?? 0}`;
    const cached = cache?.getRevisionMaterialization(revisionId);
    const contents = cached?.contents ?? (await readText(this.#artifacts, source.contents))!,
      datasetsContents = cached ? cached.datasetsContents : await readText(this.#artifacts, source.datasetsContents);
    if (!sameJson(match, this.#executionBundle(selection)))
      throw new Error('Local catalog execution target changed concurrently while loading.');
    const admitted = cached || cache?.setRevisionMaterialization({ revisionId, contents, datasetsContents });
    let webApp: LocalExecutionSnapshot['webApp'];
    if (match.app) {
      const { contents: _contents, datasetsContents: _datasets, ...metadata } = match.app;
      webApp = metadata;
    }
    return {
      workflowId: project.workflowId,
      relativePath: project.relativePath,
      endpointAccess: project.endpointAccess,
      contents,
      datasetsContents,
      cacheStatus: cached ? 'hit' : admitted ? 'miss' : 'bypass',
      ...(webApp ? { webApp } : {}),
    };
  }

  /** Atomic structure mutation. The path-set guards prevent phantom inserts
   * during folder moves/deletes; project guards also cover publication changes.
   * No physical blob deletion is performed here or after commit. */
  async applyChanges(options: {
    expectedFolders: string[];
    expectedProjectPaths: string[];
    folders: string[];
    projects: LocalCatalogChange[];
  }): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    options = structuredClone(options);
    const ordered = (items: string[]) => [...items].sort((a, b) => a.localeCompare(b));
    for (const folder of options.folders) assertPath(folder, 'folder');
    if (new Set(options.folders).size !== options.folders.length) throw new Error('Duplicate local catalog folder.');
    const ids = new Set<string>();
    const encoded: Array<{ before: StoredProjectBundle | null; after: StoredProjectBundle | null }> = [];
    for (const change of options.projects) {
      if (!change.before && !change.after) throw new Error('Empty local catalog change.');
      for (const snapshot of [change.before, change.after]) if (snapshot) assertProjectSnapshot(snapshot);
      const id = (change.before ?? change.after)!.workflowId;
      if (ids.has(id) || (change.after && change.after.workflowId !== id))
        throw new Error('Invalid project identity change.');
      ids.add(id);
      if (change.before) await this.readProject(change.before.relativePath);
      encoded.push({
        before: change.before ? await this.#encodeProject(change.before, false) : null,
        after: change.after ? await this.#encodeProject(change.after, true) : null,
      });
    }
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#upgradeSchema(db);
      if (
        !sameJson(this.listFolders(), ordered(options.expectedFolders)) ||
        !sameJson(this.listProjectPaths(), ordered(options.expectedProjectPaths))
      ) {
        throw new Error('Local catalog structure changed concurrently; reload before saving.');
      }
      for (const change of encoded) {
        if (change.before) {
          if (!sameProjectBundle(this.#readStoredProjectBundle(change.before.project.relativePath), change.before))
            throw new Error('Local catalog project changed concurrently; reload before saving.');
        } else if (
          db
            .prepare('SELECT 1 FROM projects WHERE workflow_id = ? OR relative_path = ?')
            .get(change.after!.project.workflowId, change.after!.project.relativePath)
        ) {
          throw new Error('Local catalog project already exists.');
        }
      }
      // Free old paths before publishing the new ones, without deleting project
      // identities (which would cascade-delete historical recordings).
      const temporary = `.__catalog_move__-${randomUUID()}`;
      for (const change of encoded) {
        if (!change.before) continue;
        if (!change.after)
          db.prepare('DELETE FROM projects WHERE workflow_id = ?').run(change.before.project.workflowId);
        else
          db.prepare('UPDATE projects SET relative_path = ? WHERE workflow_id = ?').run(
            `${temporary}/${change.before.project.workflowId}`,
            change.before.project.workflowId,
          );
      }
      db.exec('DELETE FROM folders');
      for (const folder of options.folders) db.prepare('INSERT INTO folders VALUES (?)').run(folder);
      for (const change of encoded) {
        if (!change.after) continue;
        const { project, versions, apps } = change.after;
        this.#assertStoredArtifacts(project);
        const parent = path.posix.dirname(project.relativePath);
        if (parent !== '.' && !options.folders.includes(parent))
          throw new Error('Local project parent folder is missing.');
        if (change.before) {
          db.prepare(
            'UPDATE projects SET relative_path = ?, endpoint_name = ?, published_endpoint_name = ?, metadata_json = ? WHERE workflow_id = ?',
          ).run(
            project.relativePath,
            project.endpointName,
            project.publishedEndpointName,
            JSON.stringify(project),
            project.workflowId,
          );
          db.prepare('DELETE FROM published_versions WHERE workflow_id = ?').run(project.workflowId);
          db.prepare('DELETE FROM web_apps WHERE workflow_id = ?').run(project.workflowId);
        } else
          db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
            project.workflowId,
            project.relativePath,
            project.endpointName,
            project.publishedEndpointName,
            JSON.stringify(project),
          );
        this.#insertProjectChildren(db, project.workflowId, versions, apps);
      }
      for (const folder of options.folders) {
        const parent = path.posix.dirname(folder);
        if (parent !== '.' && !options.folders.includes(parent)) throw new Error('Local folder parent is missing.');
      }
      // Unchanged rows must still have a parent after a folder deletion.
      for (const projectPath of this.listProjectPaths()) {
        const parent = path.posix.dirname(projectPath);
        if (parent !== '.' && !options.folders.includes(parent))
          throw new Error('Local project parent folder is missing.');
      }
      this.#validateRoutes(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Moves/deletes alter catalog structure, not immutable bodies or history. */
  async applyStructureChanges(options: {
    expectedFolders: string[];
    expectedProjectPaths: string[];
    folders: string[];
    projects: Array<{ before: LocalWorkflowTreeProject; relativePath: string | null }>;
  }): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    options = structuredClone(options);
    const ordered = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
    const observed = new Map<string, StoredProject>();
    for (const change of options.projects) {
      const current = this.#readStoredProjectBundle(change.before.relativePath, false)?.project;
      if (
        !current ||
        current.workflowId !== change.before.workflowId ||
        current.publicationVersion !== change.before.publicationVersion ||
        (await this.#treeIndex(current)).revisionId !== change.before.revisionId ||
        observed.has(current.workflowId)
      )
        throw new Error('Local catalog project changed concurrently; reload before saving.');
      observed.set(current.workflowId, current);
    }
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#upgradeSchema(db);
      if (
        !sameJson(this.listFolders(), ordered(options.expectedFolders)) ||
        !sameJson(this.listProjectPaths(), ordered(options.expectedProjectPaths))
      )
        throw new Error('Local catalog structure changed concurrently; reload before saving.');
      for (const folder of options.folders) assertPath(folder, 'folder');
      if (new Set(options.folders).size !== options.folders.length) throw new Error('Duplicate local catalog folder.');
      const ids = new Set<string>();
      const changes = options.projects.map((change) => {
        const current = this.#readStoredProjectBundle(change.before.relativePath, false)?.project;
        if (!current || !sameJson(current, observed.get(current.workflowId)) || ids.has(current.workflowId))
          throw new Error('Local catalog project changed concurrently; reload before saving.');
        ids.add(current.workflowId);
        if (change.relativePath !== null) assertPath(change.relativePath, 'project');
        return { current, relativePath: change.relativePath };
      });
      const temporary = `.__catalog_move__-${randomUUID()}`;
      for (const { current, relativePath } of changes) {
        if (relativePath === null) db.prepare('DELETE FROM projects WHERE workflow_id = ?').run(current.workflowId);
        else
          db.prepare('UPDATE projects SET relative_path = ? WHERE workflow_id = ?').run(
            `${temporary}/${current.workflowId}`,
            current.workflowId,
          );
      }
      for (const folder of options.expectedFolders)
        if (!options.folders.includes(folder)) db.prepare('DELETE FROM folders WHERE path = ?').run(folder);
      for (const folder of options.folders)
        if (!options.expectedFolders.includes(folder)) db.prepare('INSERT INTO folders VALUES (?)').run(folder);
      for (const { current, relativePath } of changes) {
        if (relativePath === null) continue;
        const fileName = path.posix.basename(relativePath);
        const next = { ...current, relativePath, fileName, name: fileName.slice(0, -'.rivet-project'.length) };
        db.prepare('UPDATE projects SET relative_path = ?, metadata_json = ? WHERE workflow_id = ?').run(
          relativePath,
          JSON.stringify(next),
          current.workflowId,
        );
      }
      for (const value of [...options.folders, ...this.listProjectPaths()]) {
        const parent = path.posix.dirname(value);
        if (parent !== '.' && !options.folders.includes(parent))
          throw new Error('Local catalog parent folder is missing.');
      }
      this.#validateRoutes(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteRecording(recordingId: string): void {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    this.#database().prepare('DELETE FROM recordings WHERE recording_id = ?').run(recordingId);
  }

  countRecordings(workflowId: string, failedOnly = false): number {
    const row = this.#database()
      .prepare(
        `SELECT COUNT(*) AS count FROM recordings WHERE ${workflowId ? 'workflow_id = ?' : '1 = 1'} ${failedOnly ? "AND json_extract(metadata_json, '$.status') IN ('failed', 'suspicious')" : ''}`,
      )
      .get(...(workflowId ? [workflowId] : [])) as { count: number };
    return row.count;
  }

  recordingScopeCounts(workflowId: string, runScope: 'all' | 'roots' | 'children' = 'all') {
    return this.#database()
      .prepare(
        `SELECT COUNT(*) AS totalRuns,
      COALESCE(SUM(json_extract(metadata_json, '$.status') = 'failed'), 0) AS failedRuns,
      COALESCE(SUM(json_extract(metadata_json, '$.status') = 'suspicious'), 0) AS suspiciousRuns
      FROM recordings WHERE ${recordingWorkflowScopeClause(workflowId, true, 'sqlite', 1, runScope)}`,
      )
      .get(...(workflowId ? [workflowId] : [])) as { totalRuns: number; failedRuns: number; suspiciousRuns: number };
  }

  /** Aggregate in SQLite; only one compact row per recording owner crosses into JS. */
  #recordingWorkflowSummaries() {
    const rows = this.#database()
      .prepare(
        `WITH metadata AS (
          SELECT recording_id, workflow_id,
            CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END AS data
          FROM recordings
        ), projected AS (
          SELECT workflow_id AS workflowId,
            json_extract(data, '$.createdAt') AS createdAt,
            json_extract(data, '$.status') AS status,
            COALESCE(
              json_type(data, '$.recordingId') = 'text' AND json_extract(data, '$.recordingId') = recording_id
              AND json_type(data, '$.workflowId') = 'text' AND json_extract(data, '$.workflowId') = workflow_id
              AND json_type(data, '$.createdAt') = 'text'
              AND substr(json_extract(data, '$.createdAt'), 12, 2) BETWEEN '00' AND '23'
              AND json_extract(data, '$.createdAt') = strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(data, '$.createdAt'))
              AND json_extract(data, '$.status') IN ('succeeded', 'failed', 'suspicious'), 0
            ) AS metadataValid
          FROM metadata
        )
        SELECT workflowId, MAX(createdAt) AS latestRunAt, COUNT(*) AS totalRuns,
          COALESCE(SUM(status = 'failed'), 0) AS failedRuns,
          COALESCE(SUM(status = 'suspicious'), 0) AS suspiciousRuns,
          MIN(metadataValid) AS metadataValid
        FROM projected GROUP BY workflowId`,
      )
      .all() as Array<{
      workflowId: string;
      latestRunAt: string;
      totalRuns: number;
      failedRuns: number;
      suspiciousRuns: number;
      metadataValid: number;
    }>;
    return rows.map(({ metadataValid, ...summary }) => {
      if (metadataValid !== 1) throw new Error('Local recording metadata is inconsistent.');
      return summary;
    });
  }

  /** Counts and their current owner metadata must come from the same commit. */
  readRecordingWorkflowProjection() {
    return this.#readMetadata(() => {
      const summaries = new Map(this.#recordingWorkflowSummaries().map((summary) => [summary.workflowId, summary]));
      // Match managed storage: published endpoints remain selectable before
      // their first run. Only compact catalog metadata is needed here.
      const published = this.#database()
        .prepare(
          `SELECT workflow_id FROM projects
        WHERE endpoint_name <> '' AND json_extract(metadata_json, '$.endpointStatus') <> 'unpublished'`,
        )
        .all() as Array<{ workflow_id: string }>;
      for (const { workflow_id: workflowId } of published) {
        if (!summaries.has(workflowId))
          summaries.set(workflowId, { workflowId, latestRunAt: '', totalRuns: 0, failedRuns: 0, suspiciousRuns: 0 });
      }
      return [...summaries.values()].flatMap((summary) => {
        const project = this.readProjectMetadataById(summary.workflowId);
        return project ? [{ ...summary, latestRunAt: summary.latestRunAt || undefined, project }] : [];
      });
    });
  }

  listRecordingMetadata(
    options: {
      recordingId?: string;
      workflowId?: string;
      includeSubgraphRuns?: boolean;
      runScope?: 'all' | 'roots' | 'children';
      failedOnly?: boolean;
      limit?: number;
      offset?: number;
      after?: { createdAt: string; recordingId: string };
      from?: string;
      to?: string;
    } = {},
  ): LocalRecordingMetadata[] {
    const conditions: string[] = [],
      values: Array<string | number> = [];
    if (options.recordingId) {
      conditions.push('recording_id = ?');
      values.push(options.recordingId);
    }
    if (options.workflowId || options.runScope === 'roots') {
      conditions.push(
        recordingWorkflowScopeClause(
          options.workflowId ?? '',
          options.includeSubgraphRuns ?? false,
          'sqlite',
          values.length + 1,
          options.runScope,
        ),
      );
      if (options.workflowId) values.push(options.workflowId);
    }
    if (options.failedOnly) conditions.push("json_extract(metadata_json, '$.status') IN ('failed', 'suspicious')");
    const created = "json_extract(metadata_json, '$.createdAt')";
    if (options.after) {
      conditions.push(`(${created} < ? OR (${created} = ? AND recording_id < ?))`);
      values.push(options.after.createdAt, options.after.createdAt, options.after.recordingId);
    }
    if (options.from) {
      conditions.push(`${created} >= ?`);
      values.push(options.from);
    }
    if (options.to) {
      conditions.push(`${created} < ?`);
      values.push(options.to);
    }
    const limit = options.limit ?? -1,
      offset = options.after ? 0 : options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < -1 || !Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Invalid recording metadata window.');
    const rows = this.#database()
      .prepare(
        `SELECT * FROM recordings ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${created} DESC, recording_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as RecordingRow[];
    return rows.map((row) => {
      const { recordingContents, replayProjectContents, replayDatasetContents, ...data } = this.#storedRecording(row);
      return {
        ...data,
        recordingHash: recordingContents!.hash,
        recordingBytes: recordingContents!.size,
        projectBytes: replayProjectContents!.size,
        datasetBytes: replayDatasetContents?.size ?? 0,
        recordingDecodedBytes: recordingContents!.decodedSize ?? recordingContents!.size,
        projectDecodedBytes: replayProjectContents!.decodedSize ?? replayProjectContents!.size,
        datasetDecodedBytes: replayDatasetContents?.decodedSize ?? replayDatasetContents?.size ?? 0,
        hasReplayDataset: replayDatasetContents !== null,
      };
    });
  }

  readRecordingStatisticsCatalog(surface: WorkflowRunStatisticsSurface) {
    const query = recordingStatisticsCatalogSql('sqlite', surface);
    return (
      this.#database()
        .prepare(query.sql)
        .all(...query.values) as RecordingStatisticsSqlRow[]
    ).map(statisticsSqlRow);
  }

  readRecordingStatistics(query: WorkflowRunStatisticsQuery) {
    const statement = recordingStatisticsRowsSql('sqlite', query);
    return (
      this.#database()
        .prepare(statement.sql)
        .all(...statement.values) as RecordingStatisticsSqlRow[]
    ).map(statisticsSqlRow);
  }

  #storedRecording(row: RecordingRow): StoredRecording {
    const data = JSON.parse(row.metadata_json) as StoredRecording;
    if (
      data.recordingId !== row.recording_id ||
      data.workflowId !== row.workflow_id ||
      !data.recordingContents ||
      !data.replayProjectContents ||
      !Number.isFinite(data.durationMs) ||
      data.durationMs < 0 ||
      !isRecordingTimestamp(data.createdAt) ||
      !['published', 'latest', 'editor'].includes(data.runKind) ||
      !['succeeded', 'failed', 'suspicious'].includes(data.status)
    )
      throw new Error('Local recording metadata is inconsistent.');
    for (const ref of [data.recordingContents, data.replayProjectContents, data.replayDatasetContents]) {
      assertRecordingArtifactReference(ref);
    }
    return data;
  }

  async readRecordingArtifact(
    recordingId: string,
    artifact: 'recording' | 'replay-project' | 'replay-dataset',
  ): Promise<string | null> {
    const row = this.#database().prepare('SELECT * FROM recordings WHERE recording_id = ?').get(recordingId) as
      | RecordingRow
      | undefined;
    if (!row) return null;
    const data = this.#storedRecording(row);
    const ref =
      artifact === 'recording'
        ? data.recordingContents
        : artifact === 'replay-project'
          ? data.replayProjectContents
          : data.replayDatasetContents;
    return readRecordingText(this.#artifacts, ref);
  }

  async importProject(snapshot: LocalWorkflowCatalogSnapshot): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    snapshot = structuredClone(snapshot);
    assertProjectSnapshot(snapshot);
    const existing = await this.readProject(snapshot.relativePath);
    if (existing) {
      if (!sameJson(existing, snapshot)) throw new LocalUpgradeDiagnosticError('candidate-retry-mismatch');
      return;
    }
    const { project, versions, apps } = await this.#encodeProject(snapshot, true);
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#upgradeSchema(db);
      this.#assertStoredArtifacts(project);
      db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)').run(
        snapshot.workflowId,
        snapshot.relativePath,
        snapshot.endpointName,
        snapshot.publishedEndpointName,
        JSON.stringify(project),
      );
      this.#insertProjectChildren(db, snapshot.workflowId, versions, apps);
      this.#validateRoutes(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async #encodeProject(
    snapshot: LocalWorkflowCatalogSnapshot,
    publishArtifacts: boolean,
  ): Promise<StoredProjectBundle> {
    const reference = (contents: string | null) =>
      publishArtifacts ? putText(this.#artifacts, contents) : Promise.resolve(hashText(contents));
    const project: StoredProject = {
      workflowId: snapshot.workflowId,
      relativePath: snapshot.relativePath,
      name: snapshot.name,
      fileName: snapshot.fileName,
      updatedAt: snapshot.updatedAt,
      endpointName: snapshot.endpointName,
      endpointAccess: snapshot.endpointAccess,
      endpointStatus: snapshot.endpointStatus,
      publicationVersion: snapshot.publicationVersion,
      publishedEndpointName: snapshot.publishedEndpointName,
      publishedVersionId: snapshot.publishedVersionId,
      lastPublishedAt: snapshot.lastPublishedAt,
      contents: await reference(snapshot.contents),
      datasetsContents: await reference(snapshot.datasetsContents),
      publishedContents: await reference(snapshot.publishedContents),
      publishedDatasetsContents: await reference(snapshot.publishedDatasetsContents),
      ...(publishArtifacts ? { treeIndex: projectTreeIndex(snapshot.contents, snapshot.datasetsContents) } : {}),
    };
    const versions: StoredVersion[] = [];
    for (const version of snapshot.publishedVersions) {
      versions.push({
        versionId: version.versionId,
        endpointName: version.endpointName,
        publishedAt: version.publishedAt,
        isStarred: version.isStarred,
        comment: version.comment,
        contents: await reference(version.contents),
        datasetsContents: await reference(version.datasetsContents),
      });
    }
    const apps: StoredWebApp[] = [];
    for (const app of snapshot.publishedWebApps) {
      apps.push({
        appId: app.appId,
        uiGraphId: app.uiGraphId,
        uiGraphName: app.uiGraphName,
        slug: app.slug,
        allowedEmails: app.allowedEmails,
        publishedAt: app.publishedAt,
        contents: await reference(app.contents),
        datasetsContents: await reference(app.datasetsContents),
      });
    }
    return { project, versions, apps };
  }

  #insertProjectChildren(db: DatabaseSync, workflowId: string, versions: StoredVersion[], apps: StoredWebApp[]): void {
    for (const version of versions) {
      this.#assertStoredArtifacts(version);
      db.prepare('INSERT INTO published_versions VALUES (?, ?, ?)').run(
        version.versionId,
        workflowId,
        JSON.stringify(version),
      );
    }
    for (const app of apps) {
      this.#assertStoredArtifacts(app);
      db.prepare('INSERT INTO web_apps VALUES (?, ?, ?, ?)').run(app.appId, workflowId, app.slug, JSON.stringify(app));
    }
  }

  #readStoredProjectBundle(relativePath: string, includeHistory = true): StoredProjectBundle | null {
    return this.#readMetadata((db) => {
      const row = db.prepare('SELECT * FROM projects WHERE relative_path = ?').get(relativePath) as
        | ProjectRow
        | undefined;
      if (!row) return null;
      const project = storedProject(row);
      const versions = (
        db
          .prepare(
            `SELECT * FROM published_versions WHERE workflow_id = ? ${includeHistory ? '' : 'AND version_id = ?'} ORDER BY rowid`,
          )
          .all(row.workflow_id, ...(includeHistory ? [] : [project.publishedVersionId ?? ''])) as VersionRow[]
      ).map(storedVersion);
      const apps = (
        db.prepare('SELECT * FROM web_apps WHERE workflow_id = ? ORDER BY rowid').all(row.workflow_id) as WebAppRow[]
      ).map(storedWebApp);
      const bundle = {
        project,
        versions,
        apps,
      };
      assertPublicationPointer(project, versions, apps);
      return bundle;
    });
  }

  /**
   * Normal-write primitive for the selected local backend.
   * All new artifact bytes are durable before the SQLite CAS; a
   * failed CAS leaves only unreferenced objects, never a dangling reference.
   */
  async replaceProject(expected: LocalWorkflowCatalogSnapshot, next: LocalWorkflowCatalogSnapshot): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    expected = structuredClone(expected);
    next = structuredClone(next);
    assertProjectSnapshot(expected);
    assertProjectSnapshot(next);
    if (expected.workflowId !== next.workflowId || expected.relativePath !== next.relativePath) {
      throw new Error('Project identity or path changes require a separate catalog operation.');
    }
    // Reject corrupt current artifact references before replacing their row.
    await this.readProject(expected.relativePath);
    const expectedStored = await this.#encodeProject(expected, false);
    const nextStored = await this.#encodeProject(next, true);
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#upgradeSchema(db);
      const current = this.#readStoredProjectBundle(expected.relativePath);
      if (!sameProjectBundle(current, expectedStored)) {
        throw new Error('Local catalog project changed concurrently; reload before saving.');
      }
      this.#assertStoredArtifacts(nextStored.project);
      db.prepare(
        `UPDATE projects SET endpoint_name = ?, published_endpoint_name = ?, metadata_json = ?
         WHERE workflow_id = ? AND relative_path = ?`,
      ).run(
        next.endpointName,
        next.publishedEndpointName,
        JSON.stringify(nextStored.project),
        next.workflowId,
        next.relativePath,
      );
      db.prepare('DELETE FROM published_versions WHERE workflow_id = ?').run(next.workflowId);
      db.prepare('DELETE FROM web_apps WHERE workflow_id = ?').run(next.workflowId);
      this.#insertProjectChildren(db, next.workflowId, nextStored.versions, nextStored.apps);
      this.#validateRoutes(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  listProjectReferenceCatalog() {
    return this.listProjectPaths().map((relativePath) => {
      const bundle = this.#readStoredProjectBundle(relativePath)!;
      return {
        name: bundle.project.name,
        relativePath,
        projectMetadataId: bundle.project.workflowId,
        identity: JSON.stringify(bundle),
      };
    });
  }

  async readProjectReferenceSnapshots(relativePath: string): Promise<WorkflowProjectReferenceSnapshot[] | null> {
    const bundle = this.#readStoredProjectBundle(relativePath);
    if (!bundle) return null;
    const snapshots: WorkflowProjectReferenceSnapshot[] = [];
    const cache = new Map<string, string>();
    const read = async (ref: ArtifactRef) => {
      if (!ref) throw new Error('Project artifact is missing.');
      const key = JSON.stringify(ref);
      if (!cache.has(key)) cache.set(key, (await readText(this.#artifacts, ref))!);
      return cache.get(key)!;
    };
    snapshots.push({ source: { kind: 'saved-latest' }, contents: await read(bundle.project.contents) });
    if (bundle.project.publishedContents)
      snapshots.push({
        source: { kind: 'published-endpoint', label: bundle.project.publishedEndpointName },
        contents: await read(bundle.project.publishedContents),
      });
    for (const app of bundle.apps)
      snapshots.push({ source: { kind: 'published-web-app', label: app.slug }, contents: await read(app.contents) });
    if (!sameJson(this.#readStoredProjectBundle(relativePath), bundle))
      throw new Error('Project changed while checking references.');
    return snapshots;
  }

  hasProjectArtifact(relativePath: string, dataset = false): boolean {
    const bundle = this.#readStoredProjectBundle(relativePath, false);
    return !!bundle && (!dataset || bundle.project.datasetsContents !== null);
  }
  async readTreeProject(relativePath: string): Promise<LocalWorkflowTreeProject | null> {
    const before = this.#readStoredProjectBundle(relativePath, false);
    if (!before) return null;
    const index = await this.#treeIndex(before.project);
    if (!sameJson(before, this.#readStoredProjectBundle(relativePath, false)))
      throw new Error('Local catalog project changed concurrently while loading.');
    return { ...projectTreeMetadata(before.project, before.apps), ...index };
  }

  readProjectMetadataById(workflowId: string): Omit<LocalWorkflowTreeProject, 'revisionId' | 'stats'> | null {
    return this.#readMetadata(() => {
      const relativePath = this.findProjectPathById(workflowId);
      if (!relativePath) return null;
      const bundle = this.#readStoredProjectBundle(relativePath, false);
      return bundle ? projectTreeMetadata(bundle.project, bundle.apps) : null;
    });
  }

  readProjectPublicationMetadata(relativePath: string) {
    const bundle = this.#readStoredProjectBundle(relativePath);
    if (!bundle) return null;
    return {
      workflowId: bundle.project.workflowId,
      name: bundle.project.name,
      publishedVersionId: bundle.project.publishedVersionId,
      publishedVersions: bundle.versions.map(
        ({ contents: _contents, datasetsContents: _datasets, ...metadata }) => metadata,
      ),
    };
  }

  /** An annotation changes one SQL row, never any immutable artifact or draft revision. */
  annotatePublishedVersion(
    relativePath: string,
    versionId: string,
    update: Partial<Pick<StoredVersion, 'isStarred' | 'comment'>>,
  ) {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const bundle = this.#readStoredProjectBundle(relativePath, false);
      const row = bundle
        ? (db
            .prepare('SELECT * FROM published_versions WHERE workflow_id = ? AND version_id = ?')
            .get(bundle.project.workflowId, versionId) as VersionRow | undefined)
        : undefined;
      const current = row ? storedVersion(row) : null;
      if (!bundle || !current) {
        db.exec('ROLLBACK');
        return null;
      }
      const version = { ...current, ...update };
      assertVersionMetadata(version);
      if (!sameJson(current, version)) {
        this.#upgradeSchema(db);
        db.prepare('UPDATE published_versions SET metadata_json = ? WHERE workflow_id = ? AND version_id = ?').run(
          JSON.stringify(version),
          bundle.project.workflowId,
          versionId,
        );
      }
      db.exec('COMMIT');
      const { contents: _contents, datasetsContents: _datasets, ...metadata } = version;
      return { project: bundle.project, version: metadata };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Ordinary reads select only the requested immutable pair. Full snapshots
   * remain separate authority for mutation CAS and exact migration verification. */
  async saveDraft(options: {
    relativePath: string;
    workflowId: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
    updatedAt: string;
  }): Promise<LocalWorkflowTreeProject | null> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    options = structuredClone(options);
    const before = this.#readStoredProjectBundle(options.relativePath, false);
    if (!before) return null;
    if (before.project.workflowId !== options.workflowId)
      throw new Error('The save target belongs to a different project.');
    const oldIndex = await this.#treeIndex(before.project);
    if (options.expectedRevisionId && options.expectedRevisionId !== oldIndex.revisionId)
      throw new Error('Local catalog project changed concurrently; reload before saving.');
    const index = projectTreeIndex(options.contents, options.datasetsContents);
    const draftReference = (contents: string | null, previous: ArtifactRef) =>
      sameArtifactReference(hashText(contents), previous)
        ? Promise.resolve(previous)
        : putText(this.#artifacts, contents);
    const next = {
      ...before.project,
      contents: await draftReference(options.contents, before.project.contents),
      datasetsContents: await draftReference(options.datasetsContents, before.project.datasetsContents),
      updatedAt: options.updatedAt,
      treeIndex: index,
    };
    next.endpointStatus =
      next.publishedContents === null
        ? 'unpublished'
        : sameJson(next.contents, next.publishedContents) &&
            sameJson(next.datasetsContents, next.publishedDatasetsContents) &&
            next.endpointName.trim().toLowerCase() === next.publishedEndpointName.trim().toLowerCase()
          ? 'published'
          : 'unpublished_changes';
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!sameJson(before, this.#readStoredProjectBundle(options.relativePath, false)))
        throw new Error('Local catalog project changed concurrently; reload before saving.');
      this.#upgradeSchema(db);
      this.#assertStoredArtifacts(next);
      db.prepare('UPDATE projects SET metadata_json = ? WHERE workflow_id = ?').run(
        JSON.stringify(next),
        next.workflowId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ...projectTreeMetadata(next, before.apps), ...index };
  }

  /** Publication changes reuse the durable draft references. Old publication
   * bodies and rows are never hydrated or rewritten by ordinary mutations. */
  async mutatePublication(
    relativePath: string,
    update: (state: LocalPublicationState, revisionId: string) => void,
    requireDraft = false,
  ) {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    const before = this.#readStoredProjectBundle(relativePath, false);
    if (!before) return null;
    const index = await this.#treeIndex(before.project);
    const next: LocalPublicationState = {
      ...structuredClone(before.project),
      draftText: requireDraft ? (await readText(this.#artifacts, before.project.contents))! : '',
      publishedVersions: [],
      publishedWebApps: structuredClone(before.apps),
    };
    update(next, index.revisionId);
    const { draftText: _text, publishedVersions: added, publishedWebApps: apps, ...project } = next;
    if (
      project.workflowId !== before.project.workflowId ||
      project.relativePath !== relativePath ||
      !sameArtifactReference(project.contents, before.project.contents) ||
      !sameArtifactReference(project.datasetsContents, before.project.datasetsContents)
    )
      throw new Error('Publication cannot change the draft identity or artifacts.');
    project.endpointStatus =
      project.publishedContents === null
        ? 'unpublished'
        : sameArtifactReference(project.contents, project.publishedContents) &&
            sameArtifactReference(project.datasetsContents, project.publishedDatasetsContents) &&
            project.endpointName.trim().toLowerCase() === project.publishedEndpointName.trim().toLowerCase()
          ? 'published'
          : 'unpublished_changes';
    storedProject({
      workflow_id: project.workflowId,
      relative_path: relativePath,
      endpoint_name: project.endpointName,
      published_endpoint_name: project.publishedEndpointName,
      metadata_json: JSON.stringify(project),
    });
    for (const app of apps) assertWebAppMetadata(app);
    for (const version of added) assertVersionMetadata(version);
    assertPublicationPointer(project, [...added, ...before.versions], apps);
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!sameJson(before, this.#readStoredProjectBundle(relativePath, false)))
        throw new Error('Local catalog project changed concurrently; reload before saving.');
      this.#upgradeSchema(db);
      this.#assertStoredArtifacts(project);
      db.prepare(
        'UPDATE projects SET endpoint_name = ?, published_endpoint_name = ?, metadata_json = ? WHERE workflow_id = ?',
      ).run(project.endpointName, project.publishedEndpointName, JSON.stringify(project), project.workflowId);
      for (const version of added) {
        this.#assertStoredArtifacts(version);
        db.prepare(
          'INSERT INTO published_versions(rowid, version_id, workflow_id, metadata_json) VALUES ((SELECT COALESCE(MIN(rowid), 0) - 1 FROM published_versions), ?, ?, ?)',
        ).run(version.versionId, project.workflowId, JSON.stringify(version));
      }
      for (const old of before.apps)
        if (!apps.some((app) => app.appId === old.appId))
          db.prepare('DELETE FROM web_apps WHERE workflow_id = ? AND app_id = ?').run(project.workflowId, old.appId);
      // Release changed slugs together so a valid A/B swap is atomic too.
      const temporarySlug = `catalog-move-${randomUUID()}`;
      for (const app of apps) {
        const old = before.apps.find((item) => item.appId === app.appId);
        if (old && old.slug !== app.slug)
          db.prepare('UPDATE web_apps SET slug = ? WHERE workflow_id = ? AND app_id = ?').run(
            `${temporarySlug}-${app.appId}`,
            project.workflowId,
            app.appId,
          );
      }
      for (const app of apps) {
        this.#assertStoredArtifacts(app);
        const old = before.apps.find((item) => item.appId === app.appId);
        if (old && !sameJson(old, app))
          db.prepare('UPDATE web_apps SET slug = ?, metadata_json = ? WHERE workflow_id = ? AND app_id = ?').run(
            app.slug,
            JSON.stringify(app),
            project.workflowId,
            app.appId,
          );
        else if (!old)
          db.prepare('INSERT INTO web_apps VALUES (?, ?, ?, ?)').run(
            app.appId,
            project.workflowId,
            app.slug,
            JSON.stringify(app),
          );
      }
      this.#validateRoutes(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ...projectTreeMetadata(project, apps), ...index };
  }

  async readProjectPayload(
    relativePath: string,
    selection: 'latest' | 'published' | 'published-or-latest' | { versionId: string } = 'latest',
  ): Promise<LocalWorkflowProjectPayload | null> {
    selection = structuredClone(selection);
    const readSelection = () =>
      this.#readMetadata((db) => {
        const bundle = this.#readStoredProjectBundle(relativePath, false);
        if (!bundle) return null;
        let version: StoredVersion | null = null;
        if (typeof selection === 'object') {
          const row = db
            .prepare('SELECT * FROM published_versions WHERE workflow_id = ? AND version_id = ?')
            .get(bundle.project.workflowId, selection.versionId) as VersionRow | undefined;
          if (!row) return null;
          version = storedVersion(row);
        }
        const published =
          selection === 'published' ||
          (selection === 'published-or-latest' && bundle.project.publishedContents !== null);
        const source =
          version ??
          (published
            ? {
                contents: bundle.project.publishedContents,
                datasetsContents: bundle.project.publishedDatasetsContents,
              }
            : bundle.project);
        return { bundle, version, source: { contents: source.contents, datasetsContents: source.datasetsContents } };
      });
    const selected = readSelection();
    if (!selected) return null;
    const [contents, datasetsContents] = await Promise.all([
      readText(this.#artifacts, selected.source.contents),
      readText(this.#artifacts, selected.source.datasetsContents),
    ]);
    if (!sameJson(selected, readSelection()))
      throw new Error('Local catalog project changed concurrently while loading.');
    return {
      ...projectTreeMetadata(selected.bundle.project, selected.bundle.apps),
      contents,
      datasetsContents,
      publishedAt: selected.version?.publishedAt ?? null,
    };
  }

  /** Publication settings need the draft definition and its saved summary, not datasets or history. */
  async readDraftDefinition(relativePath: string): Promise<(LocalWorkflowTreeProject & { contents: string }) | null> {
    const bundle = this.#readStoredProjectBundle(relativePath, false);
    if (!bundle) return null;
    const [contents, index] = await Promise.all([
      readText(this.#artifacts, bundle.project.contents),
      this.#treeIndex(bundle.project),
    ]);
    if (contents === null) throw new Error('Project artifact is missing.');
    if (!sameJson(bundle, this.#readStoredProjectBundle(relativePath, false)))
      throw new Error('Local catalog project changed concurrently while loading.');
    return { ...projectTreeMetadata(bundle.project, bundle.apps), ...index, stats: { ...index.stats }, contents };
  }

  async readProject(relativePath: string): Promise<LocalWorkflowCatalogSnapshot | null> {
    const bundle = this.#readStoredProjectBundle(relativePath);
    if (!bundle) return null;
    const {
      project: { treeIndex: _index, ...stored },
      versions,
      apps,
    } = bundle;
    // Do not open one file per historical publication in parallel. A large
    // history must not exhaust file descriptors during an ordinary read.
    const publishedVersions: LocalWorkflowCatalogSnapshot['publishedVersions'] = [];
    for (const data of versions)
      publishedVersions.push({
        ...data,
        contents: (await readText(this.#artifacts, data.contents))!,
        datasetsContents: await readText(this.#artifacts, data.datasetsContents),
      });
    const publishedWebApps: LocalWorkflowCatalogSnapshot['publishedWebApps'] = [];
    for (const data of apps)
      publishedWebApps.push({
        ...data,
        contents: (await readText(this.#artifacts, data.contents))!,
        datasetsContents: await readText(this.#artifacts, data.datasetsContents),
      });
    const snapshot = {
      ...stored,
      contents: (await readText(this.#artifacts, stored.contents)) ?? '',
      datasetsContents: await readText(this.#artifacts, stored.datasetsContents),
      publishedContents: await readText(this.#artifacts, stored.publishedContents),
      publishedDatasetsContents: await readText(this.#artifacts, stored.publishedDatasetsContents),
      publishedVersions,
      publishedWebApps,
    };
    assertProjectSnapshot(snapshot);
    if (!sameJson(this.#readStoredProjectBundle(relativePath), bundle))
      throw new Error('Local catalog project changed concurrently while loading.');
    return snapshot;
  }

  async importRecording(
    recording: LocalRecordingCatalogSnapshot,
    options: RecordingCompressionOptions & { sources?: LocalRecordingSourceArtifacts } = {},
  ): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    recording = structuredClone(recording);
    options = structuredClone(options);
    const { sources } = options;
    if (!recording.recordingId || !recording.workflowId || !Number.isFinite(recording.durationMs)) {
      throw new Error('Local recording needs a stable ID, workflow ID, and duration.');
    }
    if (!isRecordingTimestamp(recording.createdAt)) throw new Error('Local recording needs a canonical UTC timestamp.');
    const existing = await this.readRecording(recording.recordingId);
    if (existing) {
      if (!sameJson(existing, recording)) {
        throw new Error(`Local catalog recording differs on retry: ${recording.recordingId}`);
      }
      return;
    }
    const stored: StoredRecording = {
      recordingId: recording.recordingId,
      workflowId: recording.workflowId,
      sourceProjectRelativePath: recording.sourceProjectRelativePath,
      sourceProjectName: recording.sourceProjectName,
      createdAt: recording.createdAt,
      runKind: recording.runKind,
      status: recording.status,
      durationMs: recording.durationMs,
      endpointName: recording.endpointName,
      errorMessage: recording.errorMessage,
      executionIdentity: recording.executionIdentity,
      recordingContents: await putRecordingText(
        this.#artifacts,
        recording.recordingContents,
        sources?.recordingContents,
        options,
      ),
      replayProjectContents: await putRecordingText(
        this.#artifacts,
        recording.replayProjectContents,
        sources?.replayProjectContents,
        options,
      ),
      replayDatasetContents: await putRecordingText(
        this.#artifacts,
        recording.replayDatasetContents,
        sources?.replayDatasetContents,
        options,
      ),
    };
    this.#storedRecording({
      recording_id: recording.recordingId,
      workflow_id: recording.workflowId,
      metadata_json: JSON.stringify(stored),
    });
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Upgrade only with a committed write, never while verifying a certificate.
      this.#upgradeSchema(db);
      this.#assertStoredArtifacts(stored);
      db.prepare('INSERT INTO recordings(recording_id, workflow_id, metadata_json) VALUES (?, ?, ?)').run(
        recording.recordingId,
        recording.workflowId,
        JSON.stringify(stored),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async readRecording(recordingId: string): Promise<LocalRecordingCatalogSnapshot | null> {
    const row = this.#database().prepare('SELECT * FROM recordings WHERE recording_id = ?').get(recordingId) as
      | RecordingRow
      | undefined;
    if (!row) return null;
    const stored = this.#storedRecording(row);
    return {
      ...stored,
      recordingContents: (await readRecordingText(this.#artifacts, stored.recordingContents))!,
      replayProjectContents: (await readRecordingText(this.#artifacts, stored.replayProjectContents))!,
      replayDatasetContents: await readRecordingText(this.#artifacts, stored.replayDatasetContents),
    };
  }

  async importRuntimeLibraryState(state: LocalRuntimeLibraryState): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    assertRuntimeLibraryState(state);
    state = {
      manifest: structuredClone(state.manifest),
      archive: state.archive === null ? null : Buffer.from(state.archive),
    };
    const existing = await this.readRuntimeLibraryState();
    if (existing) {
      if (!sameJson(existing.manifest, state.manifest) || !sameArchive(existing.archive, state.archive)) {
        throw new Error('Local catalog runtime-library state differs on retry.');
      }
      return;
    }
    const stored: StoredRuntimeLibraryState = {
      manifest: state.manifest,
      archive: state.archive === null ? null : await this.#artifacts.putBytes(state.archive),
    };
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#assertStoredArtifacts(stored);
      db.prepare('INSERT INTO runtime_library_state(slot, metadata_json) VALUES (?, ?)').run(
        'default',
        JSON.stringify(stored),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async readRuntimeLibraryState(): Promise<LocalRuntimeLibraryState | null> {
    const row = this.#database()
      .prepare("SELECT metadata_json FROM runtime_library_state WHERE slot = 'default'")
      .get() as { metadata_json: string } | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.metadata_json) as StoredRuntimeLibraryState;
    const state = { manifest: stored.manifest, archive: await readBytes(this.#artifacts, stored.archive) };
    assertRuntimeLibraryState(state);
    const after = this.#database()
      .prepare("SELECT metadata_json FROM runtime_library_state WHERE slot = 'default'")
      .get() as { metadata_json: string } | undefined;
    if (after?.metadata_json !== row.metadata_json)
      throw new Error('Runtime-library state changed concurrently while loading.');
    return state;
  }

  /** Normal runtime activation is a CAS, not an unconditional manifest rewrite.
   * New package bytes become durable before the active pointer changes. */
  async replaceRuntimeLibraryState(expected: LocalRuntimeLibraryState, next: LocalRuntimeLibraryState): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    const copy = (state: LocalRuntimeLibraryState): LocalRuntimeLibraryState => ({
      manifest: structuredClone(state.manifest),
      archive: state.archive === null ? null : Buffer.from(state.archive),
    });
    expected = copy(expected);
    next = copy(next);
    assertRuntimeLibraryState(expected);
    assertRuntimeLibraryState(next);
    const current = await this.readRuntimeLibraryState();
    if (!current || !sameJson(current.manifest, expected.manifest) || !sameArchive(current.archive, expected.archive))
      throw new Error('Runtime-library state changed concurrently; reload before activating.');
    const encode = (state: LocalRuntimeLibraryState): StoredRuntimeLibraryState => ({
      manifest: state.manifest,
      archive:
        state.archive === null
          ? null
          : { hash: createHash('sha256').update(state.archive).digest('hex'), size: state.archive.length },
    });
    if (next.archive) await this.#artifacts.putBytes(next.archive);
    const before = encode(expected),
      after = encode(next),
      db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare("SELECT metadata_json FROM runtime_library_state WHERE slot = 'default'").get() as
        | { metadata_json: string }
        | undefined;
      if (!row || !sameJson(JSON.parse(row.metadata_json), before))
        throw new Error('Runtime-library state changed concurrently; reload before activating.');
      this.#assertStoredArtifacts(after);
      db.prepare("UPDATE runtime_library_state SET metadata_json = ? WHERE slot = 'default'").run(
        JSON.stringify(after),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  #assertStoredArtifacts(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (typeof object.hash === 'string' && typeof object.size === 'number') {
      this.#artifacts.assertPresent(object as LocalArtifact);
      return;
    }
    for (const child of Object.values(object)) this.#assertStoredArtifacts(child);
  }

  /** Scan references in yielding metadata batches, without holding a writer
   * lock. A separate connection's data_version detects ALL intervening writes,
   * including this instance's own saves. Delete only after confirming that
   * proof under BEGIN IMMEDIATE; never trust a stale reference snapshot. */
  async collectOrphanArtifacts(options: { now?: number; graceMs?: number; batchSize?: number } = {}) {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    const now = options.now ?? Date.now(),
      graceMs = options.graceMs ?? 86400000,
      batchSize = options.batchSize ?? 100;
    if (
      !Number.isFinite(now) ||
      !Number.isSafeInteger(graceMs) ||
      graceMs < 3600000 ||
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 1000
    )
      throw new Error('Invalid artifact collection policy.');
    const before = now - graceMs;
    const scan = await this.#artifacts.listCollectionCandidates({
      before,
      after: this.#collectionCursor,
      limit: batchSize,
    });
    if (scan.candidates.length === 0) {
      this.#collectionCursor = scan.cursor;
      return { removed: 0, bytes: 0 };
    }
    const db = this.#database();
    const reader = new DatabaseSync(this.#databasePath, { readOnly: true });
    let removed = 0,
      bytes = 0;
    try {
      const version = () => reader.prepare('PRAGMA data_version').get()!.data_version;
      const initialVersion = version();
      const candidates = new Set(scan.candidates.map((artifact) => artifact.hash));
      const referenced = new Set<string>();
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const object = value as Record<string, unknown>;
        if (typeof object.hash === 'string' && candidates.has(object.hash)) referenced.add(object.hash);
        for (const child of Object.values(object)) visit(child);
      };
      for (const table of ['projects', 'published_versions', 'web_apps', 'recordings', 'runtime_library_state']) {
        let cursor: number | undefined;
        while (true) {
          const rows = reader
            .prepare(
              `SELECT rowid AS cursor, metadata_json FROM ${table} ${cursor === undefined ? '' : 'WHERE rowid > ?'} ORDER BY rowid LIMIT 100`,
            )
            .all(...(cursor === undefined ? [] : [cursor])) as Array<{ cursor: number; metadata_json: string }>;
          for (const row of rows) visit(JSON.parse(row.metadata_json));
          if (rows.length < 100) break;
          cursor = rows.at(-1)!.cursor;
          await yieldToRequests();
          if (version() !== initialVersion) return { removed: 0, bytes: 0 };
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        // Reader is a DIFFERENT connection: its version changes even when the
        // intervening write used this catalog's primary connection.
        if (version() === initialVersion) {
          for (const artifact of scan.candidates) {
            if (!referenced.has(artifact.hash) && this.#artifacts.removeUnreferenced(artifact, before)) {
              removed++;
              bytes += artifact.size;
            }
          }
          this.#collectionCursor = scan.cursor;
        }
        db.exec('COMMIT');
        return { removed, bytes };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      reader.close();
    }
  }

  /** Remove catalog rows first; the grace-period collector reclaims orphans. */
  pruneRecordings(options: {
    now: number;
    retentionDays: number;
    maxRunsPerEndpoint: number;
    maxTotalBytes: number;
    batchSize: number;
    heldRecordingIds?: ReadonlySet<string>;
  }): LocalRecordingMetadata[] {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    if (
      !Number.isFinite(options.now) ||
      !Number.isFinite(new Date(options.now).getTime()) ||
      ![options.retentionDays, options.maxRunsPerEndpoint, options.maxTotalBytes, options.batchSize].every(
        Number.isSafeInteger,
      ) ||
      Math.min(options.retentionDays, options.maxRunsPerEndpoint, options.maxTotalBytes) < 0 ||
      options.batchSize < 1 ||
      options.batchSize > 1000
    )
      throw new Error('Invalid recording retention policy.');
    const cutoffTime = options.now - options.retentionDays * 86400000;
    if (!Number.isFinite(new Date(cutoffTime).getTime())) throw new Error('Invalid recording retention cutoff.');
    const cutoff = new Date(cutoffTime).toISOString(),
      db = this.#database();
    const heldRecordingIds = [...(options.heldRecordingIds ?? [])];
    if (heldRecordingIds.some((id) => typeof id !== 'string' || !id))
      throw new Error('Invalid recording retention holds.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const ids = db
        .prepare(
          `WITH ranked AS (
        SELECT recording_id, json_extract(metadata_json, '$.createdAt') AS created_at,
          ROW_NUMBER() OVER (PARTITION BY workflow_id, LOWER(TRIM(json_extract(metadata_json, '$.endpointName'))) ORDER BY json_extract(metadata_json, '$.createdAt') DESC, recording_id DESC) AS run_rank,
          json_extract(metadata_json, '$.recordingContents.size') + json_extract(metadata_json, '$.replayProjectContents.size') +
            COALESCE(json_extract(metadata_json, '$.replayDatasetContents.size'), 0) AS bytes
        FROM recordings WHERE recording_id NOT IN (SELECT value FROM json_each(?))
      ), eligible AS (
        SELECT *, SUM(bytes) OVER (ORDER BY created_at DESC, recording_id DESC ROWS UNBOUNDED PRECEDING) AS newest_bytes
        FROM ranked WHERE (? = 0 OR created_at >= ?) AND (? = 0 OR run_rank <= ?)
      ), discarded AS (
        SELECT recording_id, created_at FROM ranked WHERE recording_id NOT IN (SELECT recording_id FROM eligible)
        UNION ALL SELECT recording_id, created_at FROM eligible WHERE ? > 0 AND newest_bytes > ?
      ) SELECT recording_id FROM discarded
        ORDER BY created_at, recording_id LIMIT ?`,
        )
        .all(
          JSON.stringify(heldRecordingIds),
          options.retentionDays,
          cutoff,
          options.maxRunsPerEndpoint,
          options.maxRunsPerEndpoint,
          options.maxTotalBytes,
          options.maxTotalBytes,
          options.batchSize,
        ) as Array<{ recording_id: string }>;
      const deleted = ids.map(
        ({ recording_id }) => this.listRecordingMetadata({ recordingId: recording_id, limit: 1 })[0]!,
      );
      for (const row of deleted) db.prepare('DELETE FROM recordings WHERE recording_id = ?').run(row.recordingId);
      db.exec('COMMIT');
      return deleted;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async verifyRecordingsExact(recordings: LocalRecordingCatalogSnapshot[]): Promise<void> {
    await this.verifyRecordingStream(recordings);
  }

  async verifyRecordingStream(
    recordings: AsyncIterable<LocalRecordingCatalogSnapshot> | Iterable<LocalRecordingCatalogSnapshot>,
  ): Promise<number> {
    const remaining = new Set(this.listRecordingIds());
    let count = 0;
    for await (const recording of recordings) {
      if (!remaining.delete(recording.recordingId)) throw new Error('Local catalog recording set differs from source.');
      if (!sameJson(await this.readRecording(recording.recordingId), recording)) {
        throw new Error(`Local catalog recording differs from source: ${recording.recordingId}`);
      }
      count++;
    }
    if (remaining.size) throw new Error('Local catalog recording set differs from source.');
    return count;
  }

  async verifyExact(folders: string[], projects: LocalWorkflowCatalogSnapshot[]): Promise<void> {
    await this.verifyProjectStream(folders, projects);
  }

  async verifyProjectStream(
    folders: string[],
    projects: AsyncIterable<LocalWorkflowCatalogSnapshot> | Iterable<LocalWorkflowCatalogSnapshot>,
  ): Promise<{ folders: number; projects: number; publishedVersions: number; publishedWebApps: number }> {
    const sortedFolders = [...folders].sort((left, right) => left.localeCompare(right));
    if (!sameJson(this.listFolders(), sortedFolders)) throw new Error('Local catalog folder set differs from source.');
    const remaining = new Set(this.listProjectPaths());
    const report = { folders: folders.length, projects: 0, publishedVersions: 0, publishedWebApps: 0 };
    for await (const project of projects) {
      if (!remaining.delete(project.relativePath)) throw new Error('Local catalog project set differs from source.');
      const actual = await this.readProject(project.relativePath);
      if (!sameJson(actual, project))
        throw new Error(`Local catalog project differs from source: ${project.relativePath}`);
      report.projects++;
      report.publishedVersions += project.publishedVersions.length;
      report.publishedWebApps += project.publishedWebApps.length;
    }
    if (remaining.size) throw new Error('Local catalog project set differs from source.');
    return report;
  }
}
