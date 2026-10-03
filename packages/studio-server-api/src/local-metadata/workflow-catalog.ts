import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { ImmutableLocalArtifactStore, type LocalArtifact } from './immutable-artifact-store.js';
import type { WorkflowRecordingExecutionIdentity } from '../../../studio-server-shared/workflow-recording-types.js';
import type { RuntimeLibraryManifest } from '../runtime-libraries/manifest.js';
import { decodeMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import type { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';

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
type StoredRecording = Omit<
  LocalRecordingCatalogSnapshot,
  'recordingContents' | 'replayProjectContents' | 'replayDatasetContents'
> & {
  recordingContents: ArtifactRef;
  replayProjectContents: ArtifactRef;
  replayDatasetContents: ArtifactRef;
};
export type LocalRecordingMetadata = Omit<
  LocalRecordingCatalogSnapshot,
  'recordingContents' | 'replayProjectContents' | 'replayDatasetContents'
> & {
  recordingHash: string;
  recordingBytes: number;
  projectBytes: number;
  datasetBytes: number;
  hasReplayDataset: boolean;
};
type StoredProjectBundle = { project: StoredProject; versions: StoredVersion[]; apps: StoredWebApp[] };
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
const SCHEMA_VERSION = 2;
const SCHEMA = `
CREATE TABLE folders (path TEXT PRIMARY KEY);
CREATE TABLE projects (
  workflow_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  endpoint_name TEXT NOT NULL,
  published_endpoint_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE UNIQUE INDEX projects_endpoint_name_unique ON projects(endpoint_name) WHERE endpoint_name <> '';
CREATE UNIQUE INDEX projects_published_endpoint_name_unique ON projects(published_endpoint_name) WHERE published_endpoint_name <> '';
CREATE TABLE published_versions (
  version_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL
);
CREATE TABLE web_apps (
  app_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES projects(workflow_id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL
);
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
  const bytes = await store.read(ref.hash);
  if (bytes.length !== ref.size) throw new Error(`Local catalog artifact ${ref.hash} has an unexpected size.`);
  return bytes;
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

/** Candidate-only catalog. The serving filesystem backend does not select this class. */
export class LocalWorkflowCatalog {
  readonly #databasePath: string;
  readonly #artifacts: ImmutableLocalArtifactStore;
  #db: DatabaseSync | null = null;
  #readOnly = false;

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
        const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
        if (existing) throw new Error('Local workflow catalog path contains an unidentified database.');
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
        try {
          db.exec(SCHEMA);
          db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } else if (identity !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error('Local workflow catalog has an unsupported database identity or schema version.');
      }
      if (!readOnly) db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (integrity.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
        throw new Error('Local workflow catalog failed SQLite integrity checks.');
      }
      const expectedSchemaNames: string[] = [];
      for (const statement of SCHEMA_STATEMENTS) {
        const name = /\b(?:TABLE|INDEX) ([a-z_]+)/.exec(statement)?.[1];
        if (!name) throw new Error('Local workflow catalog has an invalid expected schema.');
        expectedSchemaNames.push(name);
        const actual = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as
          | { sql: string }
          | undefined;
        if (!actual || normalizedSql(actual.sql) !== normalizedSql(statement)) {
          throw new Error(`Local workflow catalog schema is incompatible at ${name}.`);
        }
      }
      const actualSchemaNames = (
        db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      if (!sameJson(actualSchemaNames, expectedSchemaNames.sort())) {
        throw new Error('Local workflow catalog schema contains unexpected objects.');
      }
      if (!readOnly) chmodSync(this.#databasePath, 0o600);
      this.#db = db;
      this.#readOnly = readOnly;
      this.#validateRoutes(db);
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
  }

  checkHealth(): void {
    const db = this.#database();
    const identity = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const integrity = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    if (
      identity !== APPLICATION_ID ||
      version !== SCHEMA_VERSION ||
      integrity.length !== 1 ||
      integrity[0]?.quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()
    )
      throw new Error('Local workflow catalog failed its health check.');
  }

  #database(): DatabaseSync {
    if (!this.#db) throw new Error('Local workflow catalog is not initialized.');
    return this.#db;
  }

  #validateRoutes(db: DatabaseSync): void {
    const endpoints = new Map<string, string>();
    for (const row of db
      .prepare('SELECT workflow_id, endpoint_name, published_endpoint_name FROM projects')
      .all() as ProjectRow[]) {
      for (const name of [row.endpoint_name, row.published_endpoint_name]) {
        if (!name) continue;
        const key = name.toLowerCase(),
          owner = endpoints.get(key);
        if (owner && owner !== row.workflow_id)
          throw new Error('Local catalog endpoint already exists (case-insensitive route collision).');
        endpoints.set(key, row.workflow_id);
      }
    }
    const slugs = new Set<string>();
    for (const row of db.prepare('SELECT slug FROM web_apps').all() as WebAppRow[]) {
      const key = row.slug.toLowerCase();
      if (slugs.has(key))
        throw new Error('Local catalog web-app slug already exists (case-insensitive route collision).');
      slugs.add(key);
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

  /** Tree-only logical stamp; recording traffic must not invalidate tree reads. */
  changeStamp(): string {
    const db = this.#database();
    const digest = createHash('sha256');
    for (const sql of [
      'SELECT * FROM folders ORDER BY path',
      'SELECT * FROM projects ORDER BY workflow_id',
      'SELECT * FROM published_versions ORDER BY version_id',
      'SELECT * FROM web_apps ORDER BY app_id',
    ])
      digest.update(JSON.stringify(db.prepare(sql).all())).update('\0');
    return digest.digest('hex');
  }

  listRecordingIds(): string[] {
    return (this.#database().prepare('SELECT recording_id FROM recordings').all() as RecordingRow[])
      .map((row) => row.recording_id)
      .sort((left, right) => left.localeCompare(right));
  }

  findProjectPathById(workflowId: string): string | null {
    const row = this.#database().prepare('SELECT relative_path FROM projects WHERE workflow_id = ?').get(workflowId) as
      | { relative_path: string }
      | undefined;
    return row?.relative_path ?? null;
  }

  #executionBundle(selection: LocalExecutionSelection): { bundle: StoredProjectBundle; app?: StoredWebApp } | null {
    const db = this.#database();
    let row: { relative_path: string } | undefined;
    if ('workflowId' in selection) {
      row = db
        .prepare('SELECT relative_path FROM projects WHERE workflow_id = ?')
        .get(selection.workflowId) as typeof row;
    } else if ('endpointName' in selection) {
      const column = selection.version === 'published' ? 'published_endpoint_name' : 'endpoint_name';
      row = db
        .prepare(`SELECT relative_path FROM projects WHERE ${column} = ? COLLATE NOCASE AND ${column} <> ''`)
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
    const bundle = this.#readStoredProjectBundle(db, row.relative_path)!;
    const app =
      'webAppSlug' in selection
        ? bundle.apps.find((app) => app.slug.toLowerCase() === selection.webAppSlug.toLowerCase())
        : undefined;
    if ('webAppSlug' in selection && !app) throw new Error('Local catalog web-app lookup is inconsistent.');
    return { bundle, ...(app ? { app } : {}) };
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
      if (
        !sameJson(this.listFolders(), ordered(options.expectedFolders)) ||
        !sameJson(this.listProjectPaths(), ordered(options.expectedProjectPaths))
      ) {
        throw new Error('Local catalog structure changed concurrently; reload before saving.');
      }
      for (const change of encoded) {
        if (change.before) {
          if (!sameJson(this.#readStoredProjectBundle(db, change.before.project.relativePath), change.before))
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

  listRecordingMetadata(
    options: {
      recordingId?: string;
      workflowId?: string;
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
    if (options.workflowId) {
      conditions.push('workflow_id = ?');
      values.push(options.workflowId);
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
        hasReplayDataset: replayDatasetContents !== null,
      };
    });
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
      !Number.isFinite(Date.parse(data.createdAt)) ||
      !['published', 'latest', 'editor'].includes(data.runKind) ||
      !['succeeded', 'failed', 'suspicious'].includes(data.status)
    )
      throw new Error('Local recording metadata is inconsistent.');
    for (const ref of [data.recordingContents, data.replayProjectContents, data.replayDatasetContents]) {
      if (ref !== null && (!ref || !/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.size) || ref.size < 0))
        throw new Error('Invalid local recording artifact reference.');
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
    return readText(this.#artifacts, ref);
  }

  async importProject(snapshot: LocalWorkflowCatalogSnapshot): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    snapshot = structuredClone(snapshot);
    assertProjectSnapshot(snapshot);
    const existing = await this.readProject(snapshot.relativePath);
    if (existing) {
      if (!sameJson(existing, snapshot))
        throw new Error(`Local catalog project differs on retry: ${snapshot.relativePath}`);
      return;
    }
    const { project, versions, apps } = await this.#encodeProject(snapshot, true);
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
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
      db.prepare('INSERT INTO published_versions VALUES (?, ?, ?)').run(
        version.versionId,
        workflowId,
        JSON.stringify(version),
      );
    }
    for (const app of apps) {
      db.prepare('INSERT INTO web_apps VALUES (?, ?, ?, ?)').run(app.appId, workflowId, app.slug, JSON.stringify(app));
    }
  }

  #readStoredProjectBundle(db: DatabaseSync, relativePath: string): StoredProjectBundle | null {
    const row = db.prepare('SELECT * FROM projects WHERE relative_path = ?').get(relativePath) as
      | ProjectRow
      | undefined;
    if (!row) return null;
    const project = JSON.parse(row.metadata_json) as StoredProject;
    assertProjectMetadata(project);
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
    ) {
      throw new Error(`Local catalog project row is inconsistent: ${relativePath}`);
    }
    const versions = (
      db
        .prepare('SELECT * FROM published_versions WHERE workflow_id = ? ORDER BY rowid')
        .all(row.workflow_id) as VersionRow[]
    ).map((version) => {
      const stored = JSON.parse(version.metadata_json) as StoredVersion;
      assertVersionMetadata(stored);
      for (const ref of [stored.contents, stored.datasetsContents]) assertArtifactReference(ref);
      if (stored.versionId !== version.version_id || stored.contents === null) {
        throw new Error('Local catalog version row is inconsistent.');
      }
      return stored;
    });
    const apps = (
      db.prepare('SELECT * FROM web_apps WHERE workflow_id = ? ORDER BY rowid').all(row.workflow_id) as WebAppRow[]
    ).map((app) => {
      const stored = JSON.parse(app.metadata_json) as StoredWebApp;
      assertWebAppMetadata(stored);
      for (const ref of [stored.contents, stored.datasetsContents]) assertArtifactReference(ref);
      if (stored.appId !== app.app_id || stored.slug !== app.slug || stored.contents === null) {
        throw new Error('Local catalog web-app row is inconsistent.');
      }
      return stored;
    });
    const bundle = {
      project,
      versions,
      apps,
    };
    assertPublicationPointer(project, versions, apps);
    return bundle;
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
      const current = this.#readStoredProjectBundle(db, expected.relativePath);
      if (!sameJson(current, expectedStored)) {
        throw new Error('Local catalog project changed concurrently; reload before saving.');
      }
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

  async readProject(relativePath: string): Promise<LocalWorkflowCatalogSnapshot | null> {
    const bundle = this.#readStoredProjectBundle(this.#database(), relativePath);
    if (!bundle) return null;
    const { project: stored, versions, apps } = bundle;
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
    if (!sameJson(this.#readStoredProjectBundle(this.#database(), relativePath), bundle))
      throw new Error('Local catalog project changed concurrently while loading.');
    return snapshot;
  }

  async importRecording(recording: LocalRecordingCatalogSnapshot): Promise<void> {
    if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
    recording = structuredClone(recording);
    if (!recording.recordingId || !recording.workflowId || !Number.isFinite(recording.durationMs)) {
      throw new Error('Local recording needs a stable ID, workflow ID, and duration.');
    }
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
      recordingContents: await putText(this.#artifacts, recording.recordingContents),
      replayProjectContents: await putText(this.#artifacts, recording.replayProjectContents),
      replayDatasetContents: await putText(this.#artifacts, recording.replayDatasetContents),
    };
    this.#storedRecording({
      recording_id: recording.recordingId,
      workflow_id: recording.workflowId,
      metadata_json: JSON.stringify(stored),
    });
    this.#database()
      .prepare('INSERT INTO recordings(recording_id, workflow_id, metadata_json) VALUES (?, ?, ?)')
      .run(recording.recordingId, recording.workflowId, JSON.stringify(stored));
  }

  async readRecording(recordingId: string): Promise<LocalRecordingCatalogSnapshot | null> {
    const row = this.#database().prepare('SELECT * FROM recordings WHERE recording_id = ?').get(recordingId) as
      | RecordingRow
      | undefined;
    if (!row) return null;
    const stored = this.#storedRecording(row);
    return {
      ...stored,
      recordingContents: (await readText(this.#artifacts, stored.recordingContents))!,
      replayProjectContents: (await readText(this.#artifacts, stored.replayProjectContents))!,
      replayDatasetContents: await readText(this.#artifacts, stored.replayDatasetContents),
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
    this.#database()
      .prepare('INSERT INTO runtime_library_state(slot, metadata_json) VALUES (?, ?)')
      .run('default', JSON.stringify(stored));
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
      db.prepare("UPDATE runtime_library_state SET metadata_json = ? WHERE slot = 'default'").run(
        JSON.stringify(after),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Metadata-only retention. Immutable objects stay until a separately audited
   * reference collector can prove that physical deletion is safe. */
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
          ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY json_extract(metadata_json, '$.createdAt') DESC, recording_id DESC) AS run_rank,
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
