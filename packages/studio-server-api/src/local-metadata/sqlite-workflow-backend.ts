import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  NodeDatasetProvider,
  serializeDatasets,
  serializeProject,
} from '@valerypopoff/rivet2-node';
import type { Project, SubgraphProjectTarget, ResolvedSubgraphProject } from '@valerypopoff/rivet2-node';
import type { PersistWorkflowExecutionRecordingOptions } from '../routes/workflows/managed/types.js';
import type {
  WorkflowRecordingInputFilter,
  WorkflowRecordingFilterStatus,
  WorkflowRunStatisticsQuery,
  WorkflowRunStatisticsSurface,
  WorkflowRecordingRunSummary,
  WorkflowRecordingRunsPageResponse,
} from '../../../studio-server-shared/workflow-recording-types.js';
import type { LocalRecordingMetadata, LocalPublicationState } from './workflow-catalog.js';
import { getWorkflowRecordingConfig } from '../routes/workflows/recordings-config.js';
import {
  buildWorkflowRunStatistics,
  buildWorkflowRunStatisticsCatalog,
} from '../routes/workflows/recording-statistics.js';
import {
  filterRecordingInputWindows,
  createWorkflowRecordingInputAfter,
  parseWorkflowRecordingInputAfter,
} from '../routes/workflows/recording-input-filter.js';
import { workflowRecordingInputCache } from '../routes/workflows/recording-input-cache.js';
import { getFilesystemLLMProfileHealthHeldRecordingIds } from '../llm-profile-health/filesystem-store.js';
import type {
  WorkflowProjectItem,
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowPublicationPreconditions,
  WorkflowDraftPublicationPreconditions,
  WorkflowProjectWebAppsResponse,
  WorkflowPublishedVersionSummary,
} from '../../../studio-server-shared/workflow-types.js';
import {
  getAggregateWorkflowProjectStatus,
  WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH,
} from '../../../studio-server-shared/workflow-types.js';
import {
  LocalWorkflowCatalog,
  type LocalWorkflowCatalogSnapshot,
  type LocalCatalogChange,
  type LocalExecutionSnapshot,
  type LocalWorkflowTreeProject,
} from './workflow-catalog.js';
import { badRequest, conflict, createHttpError } from '../utils/httpError.js';
import { createBlankProjectFile, sanitizeWorkflowName } from '../routes/workflows/fs-helpers.js';
import {
  normalizeHostedProjectTitle,
  parseHostedProjectContents,
} from '../routes/workflows/hosted-project-contents.js';
import {
  getFilesystemProjectRevisionId,
  getWorkflowProjectStatsFromContents,
} from '../routes/workflows/project-stats.js';
import { normalizeManagedWorkflowRelativePath } from '../routes/workflows/virtual-paths.js';
import {
  normalizeStoredEndpointName,
  normalizeWorkflowEndpointLookupName,
} from '../routes/workflows/endpoint-names.js';
import {
  assertPublicationPreconditions,
  nextPublicationVersion,
} from '../routes/workflows/publication-preconditions.js';
import {
  normalizeWebAppPublicationDrafts,
  normalizeWebAppAccessDrafts,
} from '../routes/workflows/web-app-publication-drafts.js';
import { hasProjectMainGraph, requireProjectMainGraphForEndpoint } from '../routes/workflows/main-graph.js';
import { listSavedLatestSubgraphProjectIds } from '../routes/workflows/subgraph-publication-dependencies.js';
import {
  getWorkflowDownloadFileName,
  getWorkflowDuplicateProjectName,
} from '../routes/workflows/workflow-project-naming.js';
import { notifyWebAppSocketPolicyInvalidation } from '../routes/workflows/web-app-policy-invalidation.js';
import type { WorkflowDataBackend } from '../routes/workflows/data-backend.js';
import { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';

type Snapshot = LocalWorkflowCatalogSnapshot;
const parentOf = (relativePath: string) =>
  path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
const revision = (snapshot: Pick<Snapshot, 'contents' | 'datasetsContents'>) =>
  getFilesystemProjectRevisionId(snapshot.contents, snapshot.datasetsContents);
const sameContent = (
  a: Pick<Snapshot, 'contents' | 'datasetsContents'>,
  b: Pick<Snapshot, 'contents' | 'datasetsContents'>,
) => revision(a) === revision(b);
const relative = (value: unknown, folder = false, allowEmpty = false) =>
  normalizeManagedWorkflowRelativePath(value, { allowProjectFile: !folder, allowEmpty });
type Structure = { expectedFolders: string[]; expectedProjectPaths: string[] };
type WriteLease = <T>(operation: () => Promise<T>) => Promise<T>;

/** Local SQL serving operations. Construction follows the durable generation
 * selector. The owner must supply a shared
 * maintenance-aware write lease covering the whole asynchronous operation. */
export class SqliteWorkflowBackend implements WorkflowDataBackend {
  readonly #catalog: LocalWorkflowCatalog;
  readonly #root: string;
  readonly #withWrite: WriteLease;
  readonly #cacheScope: string;
  readonly #executionCache: ManagedWorkflowExecutionCache;
  readonly #getRecordingRetentionHolds: () => Promise<ReadonlySet<string>>;
  readonly #beforeDeleteProject: (projectId: string) => Promise<void>;
  #readOnly = false;
  #closing = false;
  #activeWrites = 0;
  #disposePromise: Promise<void> | null = null;
  readonly #idleWaiters = new Set<() => void>();
  constructor(options: {
    databasePath: string;
    artifactRoot: string;
    virtualRoot: string;
    withWrite: WriteLease;
    getRecordingRetentionHolds?: () => Promise<ReadonlySet<string>>;
    beforeDeleteProject?: (projectId: string) => Promise<void>;
  }) {
    this.#catalog = new LocalWorkflowCatalog(options);
    this.#root = path.resolve(options.virtualRoot);
    this.#beforeDeleteProject = options.beforeDeleteProject ?? (async () => {});
    const withWrite = options.withWrite;
    this.#withWrite = async (operation) => {
      if (this.#closing) throw createHttpError(503, 'Local workflow storage is shutting down.');
      if (this.#readOnly) throw new Error('Local workflow catalog is open for verification only.');
      // Count before entering the owner's lease, so queued writes are drained
      // too. A rejected lease must release the count just like a failed write.
      this.#activeWrites += 1;
      try {
        return await withWrite(operation);
      } finally {
        this.#activeWrites -= 1;
        if (this.#activeWrites === 0) for (const ready of [...this.#idleWaiters]) ready();
      }
    };
    this.#cacheScope = `sqlite:${path.resolve(options.databasePath)}:`;
    this.#executionCache = new ManagedWorkflowExecutionCache();
    this.#getRecordingRetentionHolds =
      options.getRecordingRetentionHolds ?? getFilesystemLLMProfileHealthHeldRecordingIds;
  }
  initialize(options: { readOnly?: boolean } = {}): void {
    if (this.#disposePromise) throw new Error('Cannot initialize local workflow storage while shutdown is pending.');
    this.#catalog.initialize({ verifyOnly: options.readOnly, requireExisting: true });
    this.#readOnly = options.readOnly ?? false;
    this.#closing = false;
  }
  getActiveWriteCount(): number {
    return this.#activeWrites;
  }
  close(): void {
    if (this.#activeWrites) throw new Error('Cannot close local workflow storage with pending writes; drain it first.');
    this.#closing = true;
    this.#catalog.close();
    this.#executionCache.clearRevisionMaterializations();
  }

  /** Caller must establish the durable maintenance fence before draining. */
  async waitForIdle(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.#activeWrites) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.#idleWaiters.delete(ready);
        signal?.removeEventListener('abort', aborted);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(signal!.reason);
      };
      this.#idleWaiters.add(ready);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#closing = true;
    this.#disposePromise = (async () => {
      await this.waitForIdle();
      this.close();
    })().finally(() => {
      this.#disposePromise = null;
    });
    return this.#disposePromise;
  }

  async checkHealth(context?: { signal: AbortSignal }): Promise<void> {
    context?.signal.throwIfAborted();
    if (this.#closing) throw new Error('Local workflow storage is shutting down.');
    this.#catalog.checkHealth();
    context?.signal.throwIfAborted();
  }
  #absolute(value: string): string {
    return path.join(this.#root, ...value.split('/'));
  }
  #parseAbsolute(value: string): string {
    const result = path.relative(this.#root, path.resolve(value)).replaceAll('\\', '/');
    if (!result || result === '..' || result.startsWith('../') || path.isAbsolute(result))
      throw badRequest('Project path must stay inside workflow storage.');
    const normalized = relative(result);
    if (!normalized.endsWith('.rivet-project')) throw badRequest('Expected project path');
    return normalized;
  }
  #structure(): Structure {
    return { expectedFolders: this.#catalog.listFolders(), expectedProjectPaths: this.#catalog.listProjectPaths() };
  }
  #requireFolder(folders: string[], value: string): void {
    if (value && !folders.includes(value)) throw createHttpError(404, 'Folder not found');
  }
  #projectPath(value: unknown): string {
    const projectPath = relative(value);
    if (!projectPath.endsWith('.rivet-project')) throw badRequest('Expected project path');
    return projectPath;
  }
  async #project(value: unknown): Promise<Snapshot> {
    const projectPath = this.#projectPath(value);
    const project = await this.#catalog.readProject(projectPath);
    if (!project) throw createHttpError(404, 'Project not found');
    return project;
  }
  async #payload(value: unknown, selection: Parameters<LocalWorkflowCatalog['readProjectPayload']>[1] = 'latest') {
    const projectPath = this.#projectPath(value);
    const project = await this.#catalog.readProjectPayload(projectPath, selection);
    if (!project) throw createHttpError(404, 'Project or published version not found');
    return project;
  }
  #status(snapshot: Snapshot): Snapshot['endpointStatus'] {
    if (snapshot.publishedContents === null) return 'unpublished';
    return sameContent(snapshot, {
      contents: snapshot.publishedContents,
      datasetsContents: snapshot.publishedDatasetsContents,
    }) &&
      normalizeWorkflowEndpointLookupName(snapshot.endpointName) ===
        normalizeWorkflowEndpointLookupName(snapshot.publishedEndpointName)
      ? 'published'
      : 'unpublished_changes';
  }
  #item(snapshot: Snapshot): WorkflowProjectItem {
    const webApps = snapshot.publishedWebApps.map((app) => ({
      ...app,
      status: sameContent(snapshot, app) ? ('published' as const) : ('unpublished_changes' as const),
    }));
    return this.#treeItem({
      ...snapshot,
      revisionId: revision(snapshot),
      stats: getWorkflowProjectStatsFromContents(snapshot.contents),
      publishedWebApps: webApps,
    });
  }
  #treeItem(
    snapshot: Omit<LocalWorkflowTreeProject, 'revisionId' | 'stats'> &
      Partial<Pick<LocalWorkflowTreeProject, 'revisionId' | 'stats'>>,
  ): WorkflowProjectItem {
    const webApps = snapshot.publishedWebApps;
    return {
      id: snapshot.relativePath,
      projectMetadataId: snapshot.workflowId,
      revisionId: snapshot.revisionId,
      name: snapshot.name,
      fileName: snapshot.fileName,
      relativePath: snapshot.relativePath,
      absolutePath: this.#absolute(snapshot.relativePath),
      updatedAt: snapshot.updatedAt,
      settings: {
        endpointName: snapshot.endpointName,
        publishedEndpointName: snapshot.publishedEndpointName,
        endpointAccess: snapshot.endpointAccess,
        status: snapshot.endpointStatus,
        publicationStatus: getAggregateWorkflowProjectStatus(
          snapshot.endpointStatus,
          webApps.map((app) => app.status),
        ),
        publicationVersion: snapshot.publicationVersion,
        lastPublishedAt: snapshot.lastPublishedAt,
        publishedWebApps: webApps.map(({ uiGraphId, uiGraphName, slug, allowedEmails, publishedAt, status }) => ({
          uiGraphId,
          uiGraphName,
          slug,
          allowedEmails,
          publishedAt,
          status,
        })),
      },
      stats: snapshot.stats,
    };
  }
  #folder(value: string): WorkflowFolderItem {
    return {
      id: value,
      name: path.posix.basename(value),
      relativePath: value,
      absolutePath: this.#absolute(value),
      updatedAt: '',
      folders: [],
      projects: [],
    };
  }
  async #commitStructure(
    structure: Structure,
    projects: Array<{ before: LocalWorkflowTreeProject; relativePath: string | null }>,
    folders = structure.expectedFolders,
  ) {
    try {
      await this.#catalog.applyStructureChanges({ ...structure, projects, folders });
    } catch (error) {
      if (/concurrently|UNIQUE constraint|route collision/.test(String(error)))
        throw conflict('Workflow storage changed or the destination already exists. Refresh before trying again.');
      throw error;
    }
    for (const change of projects) {
      notifyWebAppSocketPolicyInvalidation(`filesystem:${this.#absolute(change.before.relativePath)}`);
      if (change.relativePath)
        notifyWebAppSocketPolicyInvalidation(`filesystem:${this.#absolute(change.relativePath)}`);
    }
  }
  async #commit(
    structure: Structure,
    projects: LocalCatalogChange[],
    folders = structure.expectedFolders,
  ): Promise<void> {
    try {
      await this.#catalog.applyChanges({ ...structure, folders, projects });
    } catch (error) {
      if (/concurrently|already exists|UNIQUE constraint/.test(String(error)))
        throw conflict('Workflow storage changed or the destination already exists. Refresh before trying again.');
      throw error;
    }
    for (const change of projects) {
      for (const project of [change.before, change.after])
        if (project) notifyWebAppSocketPolicyInvalidation(`filesystem:${this.#absolute(project.relativePath)}`);
    }
  }
  #newProject(value: string, contents: string, datasetsContents: string | null): Snapshot {
    const name = path.posix.basename(value, '.rivet-project');
    const normalized = normalizeHostedProjectTitle(contents, name, 'Could not save project');
    if (datasetsContents !== null) deserializeDatasets(datasetsContents);
    return {
      workflowId: normalized.project.metadata.id,
      relativePath: value,
      name,
      fileName: `${name}.rivet-project`,
      updatedAt: new Date().toISOString(),
      contents: normalized.contents,
      datasetsContents,
      endpointName: '',
      endpointAccess: 'public',
      endpointStatus: 'unpublished',
      publicationVersion: '0',
      publishedEndpointName: '',
      publishedVersionId: null,
      lastPublishedAt: null,
      publishedContents: null,
      publishedDatasetsContents: null,
      publishedVersions: [],
      publishedWebApps: [],
    };
  }
  async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
    const projection = await this.#catalog.readTreeProjection();
    const folders = new Map(projection.folders.map((value) => [value, this.#folder(value)]));
    const roots: WorkflowFolderItem[] = [];
    for (const folder of folders.values()) {
      const parent = parentOf(folder.relativePath);
      if (parent && !folders.has(parent)) throw new Error('Local catalog folder parent is missing.');
      if (parent) folders.get(parent)!.folders.push(folder);
      else roots.push(folder);
    }
    const projects: WorkflowProjectItem[] = [];
    for (const project of projection.projects) {
      const item = this.#treeItem(project);
      const parent = parentOf(project.relativePath);
      if (parent && !folders.has(parent)) throw new Error('Local catalog project parent is missing.');
      if (parent) folders.get(parent)!.projects.push(item);
      else projects.push(item);
    }
    if (projection.stamp !== this.#catalog.changeStamp()) throw conflict('Workflow tree changed while loading. Retry.');
    return { root: this.#root, folders: roots, projects };
  }
  async listProjectPathsForHostedIo(): Promise<string[]> {
    return this.#catalog.listProjectPaths().map((value) => this.#absolute(value));
  }
  async loadHostedProject(projectPath: string) {
    const snapshot = await this.#payload(this.#parseAbsolute(projectPath));
    const contents = snapshot.contents!;
    return {
      contents,
      datasetsContents: snapshot.datasetsContents,
      revisionId: revision({ contents, datasetsContents: snapshot.datasetsContents }),
    };
  }
  async saveHostedProject(options: {
    projectPath: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
    projectId?: string;
    saveIntent?: 'in-place' | 'save-as';
  }) {
    options = structuredClone(options);
    return this.#withWrite(async () => {
      const structure = this.#structure();
      let value = this.#parseAbsolute(options.projectPath);
      const submitted = parseHostedProjectContents(options.contents, 'Could not save project').project;
      if (options.projectId && options.projectId !== submitted.metadata.id)
        throw badRequest('Project identity does not match submitted contents.');
      if (options.saveIntent === 'in-place') {
        const currentPath = this.#catalog.findProjectPathById(submitted.metadata.id);
        if (!currentPath) throw conflict('This project no longer exists. Reopen it or use Save As.');
        value = currentPath;
      }
      this.#requireFolder(structure.expectedFolders, parentOf(value));
      const next = this.#newProject(value, options.contents, options.datasetsContents);
      let saved: LocalWorkflowTreeProject | null;
      try {
        saved = await this.#catalog.saveDraft({
          relativePath: value,
          workflowId: submitted.metadata.id,
          contents: next.contents,
          datasetsContents: next.datasetsContents,
          expectedRevisionId: options.expectedRevisionId,
          updatedAt: next.updatedAt,
        });
      } catch (error) {
        if (/different project/.test(String(error))) throw conflict('The save target belongs to a different project.');
        if (/concurrently/.test(String(error)))
          throw conflict('Project has changed since it was opened. Reload before saving.');
        throw error;
      }
      if (saved) {
        notifyWebAppSocketPolicyInvalidation(`filesystem:${this.#absolute(value)}`);
        return {
          path: this.#absolute(value),
          revisionId: saved.revisionId,
          project: this.#treeItem(saved),
          created: false,
        };
      }
      if (options.expectedRevisionId) throw conflict('The save target no longer exists.');
      await this.#commit(structure, [{ before: null, after: next }]);
      return { path: this.#absolute(value), revisionId: revision(next), project: this.#item(next), created: true };
    });
  }
  async createWorkflowProjectItem(folderValue: unknown, nameValue: unknown): Promise<WorkflowProjectItem> {
    const folder = relative(folderValue, true, true),
      name = sanitizeWorkflowName(nameValue, 'name');
    return this.#withWrite(async () => {
      const structure = this.#structure();
      this.#requireFolder(structure.expectedFolders, folder);
      const next = this.#newProject(
        path.posix.join(folder, `${name}.rivet-project`),
        createBlankProjectFile(name),
        null,
      );
      await this.#commit(structure, [{ before: null, after: next }]);
      return this.#item(next);
    });
  }
  async uploadWorkflowProjectItem(
    folderValue: unknown,
    fileName: unknown,
    contents: unknown,
  ): Promise<WorkflowProjectItem> {
    if (typeof contents !== 'string') throw badRequest('Missing project contents');
    const folder = relative(folderValue, true, true),
      name = sanitizeWorkflowName(fileName, 'fileName').replace(/\.rivet-project$/, '');
    return this.#withWrite(async () => {
      const structure = this.#structure();
      this.#requireFolder(structure.expectedFolders, folder);
      const next = this.#newProject(path.posix.join(folder, `${name}.rivet-project`), contents, null);
      await this.#commit(structure, [{ before: null, after: next }]);
      return this.#item(next);
    });
  }
  async duplicateWorkflowProjectItem(
    value: unknown,
    version: WorkflowProjectDownloadVersion = 'live',
  ): Promise<WorkflowProjectItem> {
    return this.#withWrite(async () => {
      const structure = this.#structure(),
        source = await this.#payload(value, version === 'published' ? 'published' : 'latest');
      const contents = source.contents;
      if (contents === null) throw conflict('Published version is not available');
      const [project, attachedData] = loadProjectAndAttachedDataFromString(contents);
      project.metadata.id = randomUUID() as typeof project.metadata.id;
      let suffix = 0,
        name = getWorkflowDuplicateProjectName(source.name, version, source.endpointStatus, suffix);
      while (
        structure.expectedProjectPaths.includes(path.posix.join(parentOf(source.relativePath), `${name}.rivet-project`))
      )
        name = getWorkflowDuplicateProjectName(source.name, version, source.endpointStatus, ++suffix);
      const next = this.#newProject(
        path.posix.join(parentOf(source.relativePath), `${name}.rivet-project`),
        serializeProject(project, attachedData) as string,
        source.datasetsContents,
      );
      await this.#commit(structure, [{ before: null, after: next }]);
      return this.#item(next);
    });
  }
  async #moveProject(value: unknown, target: (source: LocalWorkflowTreeProject) => string) {
    return this.#withWrite(async () => {
      const structure = this.#structure(),
        before = await this.#catalog.readTreeProject(this.#projectPath(value));
      if (!before) throw createHttpError(404, 'Project not found');
      const newPath = target(before);
      if (newPath === before.relativePath) return { project: this.#treeItem(before), movedProjectPaths: [] };
      this.#requireFolder(structure.expectedFolders, parentOf(newPath));
      const name = path.posix.basename(newPath, '.rivet-project');
      const after = {
        ...before,
        relativePath: newPath,
        name,
        fileName: `${name}.rivet-project`,
      };
      await this.#commitStructure(structure, [{ before, relativePath: newPath }]);
      return {
        project: this.#treeItem(after),
        movedProjectPaths: [
          { fromAbsolutePath: this.#absolute(before.relativePath), toAbsolutePath: this.#absolute(newPath) },
        ],
      };
    });
  }
  renameWorkflowProjectItem(value: unknown, newName: unknown) {
    const name = sanitizeWorkflowName(newName, 'name');
    return this.#moveProject(value, (source) =>
      path.posix.join(parentOf(source.relativePath), `${name}.rivet-project`),
    );
  }
  moveWorkflowProject(value: unknown, folder: unknown) {
    const target = relative(folder, true, true);
    return this.#moveProject(value, (source) => path.posix.join(target, source.fileName));
  }
  async deleteWorkflowProjectItem(value: unknown): Promise<string | null> {
    return this.#withWrite(async () => {
      const structure = this.#structure(),
        before = await this.#catalog.readTreeProject(this.#projectPath(value));
      if (!before) throw createHttpError(404, 'Project not found');
      if (
        before.endpointStatus !== 'unpublished' ||
        before.publishedVersionId ||
        before.publishedEndpointName ||
        before.publishedWebApps.length > 0
      )
        throw conflict('Unpublish the workflow endpoint and web apps before deleting the project');
      await this.#beforeDeleteProject(before.workflowId);
      await this.#commitStructure(structure, [{ before, relativePath: null }]);
      return before.workflowId;
    });
  }
  async createWorkflowFolderItem(nameValue: unknown, parentValue: unknown): Promise<WorkflowFolderItem> {
    const name = sanitizeWorkflowName(nameValue, 'name'),
      parent = relative(parentValue, true, true),
      value = path.posix.join(parent, name);
    return this.#withWrite(async () => {
      const structure = this.#structure();
      this.#requireFolder(structure.expectedFolders, parent);
      if (structure.expectedFolders.includes(value)) throw conflict('Folder already exists');
      await this.#commitStructure(structure, [], [...structure.expectedFolders, value]);
      return this.#folder(value);
    });
  }
  async #moveFolder(value: unknown, target: (source: string) => string) {
    const source = relative(value, true);
    return this.#withWrite(async () => {
      const structure = this.#structure();
      this.#requireFolder(structure.expectedFolders, source);
      const destination = target(source);
      if (destination === source) return { folder: this.#folder(source), movedProjectPaths: [] };
      if (destination.startsWith(`${source}/`)) throw badRequest('Cannot move a folder into itself');
      this.#requireFolder(structure.expectedFolders, parentOf(destination));
      if (structure.expectedFolders.includes(destination)) throw conflict('Folder already exists');
      const inSource = (item: string) => item === source || item.startsWith(`${source}/`);
      const changes: Array<{ before: LocalWorkflowTreeProject; relativePath: string }> = [];
      for (const value of structure.expectedProjectPaths.filter(inSource)) {
        const before = await this.#catalog.readTreeProject(value);
        if (!before) throw conflict('Project changed concurrently');
        changes.push({ before, relativePath: `${destination}${value.slice(source.length)}` });
      }
      await this.#commitStructure(
        structure,
        changes,
        structure.expectedFolders.map((folder) =>
          inSource(folder) ? `${destination}${folder.slice(source.length)}` : folder,
        ),
      );
      return {
        folder: this.#folder(destination),
        movedProjectPaths: changes.map((change) => ({
          fromAbsolutePath: this.#absolute(change.before.relativePath),
          toAbsolutePath: this.#absolute(change.relativePath),
        })),
      };
    });
  }
  renameWorkflowFolderItem(value: unknown, newName: unknown) {
    const name = sanitizeWorkflowName(newName, 'name');
    return this.#moveFolder(value, (source) => path.posix.join(parentOf(source), name));
  }
  moveWorkflowFolder(value: unknown, destination: unknown) {
    const folder = relative(destination, true, true);
    return this.#moveFolder(value, (source) => path.posix.join(folder, path.posix.basename(source)));
  }
  async deleteWorkflowFolderItem(value: unknown): Promise<void> {
    const source = relative(value, true);
    return this.#withWrite(async () => {
      const structure = this.#structure();
      this.#requireFolder(structure.expectedFolders, source);
      if ([...structure.expectedFolders, ...structure.expectedProjectPaths].some((item) => item.startsWith(`${source}/`)))
        throw conflict('Only empty folders can be deleted');
      await this.#commitStructure(
        structure,
        [],
        structure.expectedFolders.filter((item) => item !== source),
      );
    });
  }
  async readWorkflowProjectReferenceSnapshots(value: unknown) {
    const projectPath = relative(value);
    if (!projectPath.endsWith('.rivet-project')) throw badRequest('Expected project path');
    const snapshots = await this.#catalog.readProjectReferenceSnapshots(projectPath);
    if (!snapshots) throw createHttpError(404, 'Project not found');
    return snapshots;
  }
  async listWorkflowProjectReferenceCatalog() {
    return this.#catalog.listProjectReferenceCatalog();
  }
  async readWorkflowProjectDownload(value: unknown, version: WorkflowProjectDownloadVersion) {
    const project = await this.#payload(value, version === 'published' ? 'published' : 'latest'),
      contents = project.contents;
    if (contents === null) throw conflict('Published version is not available');
    return { contents, fileName: getWorkflowDownloadFileName(project.name, version, project.endpointStatus) };
  }
  async #publication(
    value: unknown,
    preconditions: WorkflowPublicationPreconditions,
    kind: Parameters<typeof assertPublicationPreconditions>[2],
    update: (next: LocalPublicationState) => void,
  ) {
    preconditions = structuredClone(preconditions);
    return this.#withWrite(async () => {
      const projectPath = this.#projectPath(value);
      try {
        const result = await this.#catalog.mutatePublication(
          projectPath,
          (next, revisionId) => {
            assertPublicationPreconditions(
              preconditions,
              { projectId: next.workflowId, publicationVersion: next.publicationVersion, draftRevisionId: revisionId },
              kind,
            );
            const publicationVersion = nextPublicationVersion(next.publicationVersion);
            update(next);
            next.publicationVersion = publicationVersion;
          },
          kind === 'publish-endpoint' || kind === 'publish-web-apps',
        );
        if (!result) throw createHttpError(404, 'Project not found');
        notifyWebAppSocketPolicyInvalidation(`filesystem:${this.#absolute(projectPath)}`);
        return result;
      } catch (error) {
        if (/concurrently|UNIQUE constraint|route collision/.test(String(error)))
          throw conflict('Workflow storage changed or the destination already exists. Refresh before trying again.');
        throw error;
      }
    });
  }
  async publishWorkflowProjectItem(
    value: unknown,
    settings: unknown,
    preconditions: WorkflowDraftPublicationPreconditions,
  ) {
    const endpointName = normalizeStoredEndpointName((settings as { endpointName?: string })?.endpointName ?? '');
    if (!endpointName) throw badRequest('Missing endpoint name');
    return this.#treeItem(
      await this.#publication(value, preconditions, 'publish-endpoint', (next) => {
        requireProjectMainGraphForEndpoint(loadProjectAndAttachedDataFromString(next.draftText)[0]);
        const publishedAt = new Date().toISOString(),
          versionId = randomUUID();
        next.endpointName = next.publishedEndpointName = endpointName;
        next.publishedVersionId = versionId;
        next.lastPublishedAt = publishedAt;
        next.publishedContents = next.contents;
        next.publishedDatasetsContents = next.datasetsContents;
        next.publishedVersions.unshift({
          versionId,
          endpointName,
          publishedAt,
          isStarred: false,
          comment: '',
          contents: next.contents,
          datasetsContents: next.datasetsContents,
        });
      }),
    );
  }
  async unpublishWorkflowProjectItem(value: unknown, preconditions: WorkflowPublicationPreconditions) {
    return this.#treeItem(
      await this.#publication(value, preconditions, 'unpublish-endpoint', (next) => {
        next.publishedEndpointName = '';
        next.publishedVersionId = null;
        next.publishedContents = null;
        next.publishedDatasetsContents = null;
        next.lastPublishedAt = null;
      }),
    );
  }
  async updateWorkflowEndpointAccess(
    value: unknown,
    access: 'public' | 'internal',
    preconditions: WorkflowPublicationPreconditions,
  ) {
    if (access !== 'public' && access !== 'internal') throw badRequest('Invalid endpoint access');
    return this.#treeItem(
      await this.#publication(value, preconditions, 'set-endpoint-access', (next) => {
        next.endpointAccess = access;
      }),
    );
  }
  #uiGraphs(project: Project) {
    return Object.entries(project.uiGraphs ?? {}).map(([uiGraphId, graph]) => ({
      uiGraphId,
      name: typeof graph.name === 'string' && graph.name.trim() ? graph.name.trim() : uiGraphId,
    }));
  }
  async listWorkflowProjectWebApps(value: unknown): Promise<WorkflowProjectWebAppsResponse> {
    const snapshot = await this.#catalog.readDraftDefinition(this.#projectPath(value));
    if (!snapshot) throw createHttpError(404, 'Project not found');
    const contents = snapshot.contents,
      project = loadProjectAndAttachedDataFromString(contents)[0],
      graphs = this.#uiGraphs(project),
      draftRevisionId = snapshot.revisionId;
    return {
      project: this.#treeItem(snapshot),
      projectId: snapshot.workflowId,
      draftRevisionId,
      publicationVersion: snapshot.publicationVersion,
      hasMainGraph: hasProjectMainGraph(project),
      savedLatestSubgraphProjectIds: listSavedLatestSubgraphProjectIds(project),
      webApps: [
        ...graphs.map((graph) => {
          const app = snapshot.publishedWebApps.find((app) => app.uiGraphId === graph.uiGraphId);
          return {
            ...graph,
            publishedSlug: app?.slug ?? null,
            publishedAt: app?.publishedAt ?? null,
            allowedEmails: app?.allowedEmails ?? [],
            status: !app ? ('unpublished' as const) : app.status,
            isMissingFromProject: false,
          };
        }),
        ...snapshot.publishedWebApps
          .filter((app) => !graphs.some((graph) => graph.uiGraphId === app.uiGraphId))
          .map((app) => ({
            uiGraphId: app.uiGraphId,
            name: app.uiGraphName,
            publishedSlug: app.slug,
            publishedAt: app.publishedAt,
            allowedEmails: app.allowedEmails,
            status: 'unpublished_changes' as const,
            isMissingFromProject: true,
          })),
      ],
    };
  }
  async publishWorkflowProjectWebApps(
    value: unknown,
    publications: unknown,
    preconditions: WorkflowDraftPublicationPreconditions,
  ) {
    const drafts = normalizeWebAppPublicationDrafts(publications);
    return this.#treeItem(
      await this.#publication(value, preconditions, 'publish-web-apps', (next) => {
        const graphs = this.#uiGraphs(loadProjectAndAttachedDataFromString(next.draftText)[0]);
        const apps = drafts.map((draft) => {
          const graph = graphs.find((graph) => graph.uiGraphId === draft.uiGraphId);
          if (!graph) throw createHttpError(404, 'Web app not found');
          const previous = next.publishedWebApps.find((app) => app.uiGraphId === draft.uiGraphId);
          return {
            appId: previous?.appId ?? randomUUID(),
            uiGraphId: draft.uiGraphId,
            uiGraphName: graph.name,
            slug: draft.slug,
            allowedEmails: draft.allowedEmails ?? previous?.allowedEmails ?? [],
            publishedAt: new Date().toISOString(),
            contents: next.contents,
            datasetsContents: next.datasetsContents,
          };
        });
        next.publishedWebApps = [
          ...next.publishedWebApps.filter((app) => !drafts.some((draft) => draft.uiGraphId === app.uiGraphId)),
          ...apps,
        ];
      }),
    );
  }
  async updateWorkflowProjectWebAppAccess(
    value: unknown,
    updates: unknown,
    preconditions: WorkflowPublicationPreconditions,
  ) {
    const drafts = normalizeWebAppAccessDrafts(updates);
    return this.#treeItem(
      await this.#publication(value, preconditions, 'set-web-app-access', (next) => {
        for (const draft of drafts) {
          const app = next.publishedWebApps.find((app) => app.uiGraphId === draft.uiGraphId);
          if (!app) throw createHttpError(404, 'Published web app not found');
          app.allowedEmails = draft.allowedEmails;
        }
      }),
    );
  }
  async unpublishWorkflowProjectWebApp(
    value: unknown,
    uiGraphId: unknown,
    preconditions: WorkflowPublicationPreconditions,
  ) {
    if (typeof uiGraphId !== 'string' || !uiGraphId) throw badRequest('Missing uiGraphId');
    return this.#treeItem(
      await this.#publication(value, preconditions, 'unpublish-web-app', (next) => {
        if (!next.publishedWebApps.some((app) => app.uiGraphId === uiGraphId))
          throw createHttpError(404, 'Published web app not found');
        next.publishedWebApps = next.publishedWebApps.filter((app) => app.uiGraphId !== uiGraphId);
      }),
    );
  }
  #version(snapshot: Snapshot, value: unknown) {
    const version = snapshot.publishedVersions.find((version) => version.versionId === value);
    if (!version) throw createHttpError(404, 'Published version not found');
    return version;
  }
  #versionSummary(
    snapshot: Pick<Snapshot, 'workflowId' | 'name' | 'publishedVersionId'>,
    version: Omit<Snapshot['publishedVersions'][number], 'contents' | 'datasetsContents'>,
  ): WorkflowPublishedVersionSummary {
    return {
      id: version.versionId,
      projectId: snapshot.workflowId,
      projectName: snapshot.name,
      endpointName: version.endpointName,
      publishedAt: version.publishedAt,
      isCurrent: snapshot.publishedVersionId === version.versionId,
      isStarred: version.isStarred,
      comment: version.comment,
    };
  }
  async listWorkflowPublishedVersions(value: unknown) {
    const project = this.#catalog.readProjectPublicationMetadata(this.#projectPath(value));
    if (!project) throw createHttpError(404, 'Project not found');
    return { versions: project.publishedVersions.map((version) => this.#versionSummary(project, version)) };
  }
  async readWorkflowPublishedVersionPreview(value: unknown, id: unknown) {
    if (typeof id !== 'string') throw createHttpError(404, 'Published version not found');
    const version = await this.#payload(value, { versionId: id });
    return { contents: version.contents!, datasetsContents: version.datasetsContents };
  }
  async readWorkflowPublishedVersionDownload(value: unknown, id: unknown) {
    if (typeof id !== 'string') throw createHttpError(404, 'Published version not found');
    const version = await this.#payload(value, { versionId: id });
    return {
      contents: version.contents!,
      fileName: `${version.name} [published ${version.publishedAt!.replace(/[:]/g, '-')}].rivet-project`,
    };
  }
  async #annotateVersion(
    value: unknown,
    id: unknown,
    update: Partial<Pick<Snapshot['publishedVersions'][number], 'isStarred' | 'comment'>>,
  ) {
    if (typeof id !== 'string' || !id) throw createHttpError(404, 'Published version not found');
    return this.#withWrite(async () => {
      const result = this.#catalog.annotatePublishedVersion(this.#projectPath(value), id, update);
      if (!result) throw createHttpError(404, 'Published version not found');
      return this.#versionSummary(result.project, result.version);
    });
  }
  setWorkflowPublishedVersionStar(value: unknown, id: unknown, starred: unknown) {
    if (typeof starred !== 'boolean') throw badRequest('Invalid isStarred');
    return this.#annotateVersion(value, id, { isStarred: starred });
  }
  setWorkflowPublishedVersionComment(value: unknown, id: unknown, comment: unknown) {
    if (typeof comment !== 'string' || comment.trim().length > WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH)
      throw badRequest('Invalid comment');
    return this.#annotateVersion(value, id, { comment: comment.trim() });
  }
  async restoreWorkflowPublishedVersion(
    value: unknown,
    id: unknown,
    preconditions: WorkflowDraftPublicationPreconditions,
  ) {
    preconditions = structuredClone(preconditions);
    const snapshot = await this.#withWrite(async () => {
      const structure = this.#structure(),
        before = await this.#project(value);
      assertPublicationPreconditions(
        preconditions,
        {
          projectId: before.workflowId,
          publicationVersion: before.publicationVersion,
          draftRevisionId: revision(before),
        },
        'restore-version',
      );
      const next = structuredClone(before);
      const version = this.#version(next, id);
      requireProjectMainGraphForEndpoint(loadProjectAndAttachedDataFromString(version.contents)[0]);
      const versionId = randomUUID(),
        publishedAt = new Date().toISOString();
      next.contents = next.publishedContents = version.contents;
      next.datasetsContents = next.publishedDatasetsContents = version.datasetsContents;
      next.publishedVersionId = versionId;
      next.endpointName = next.publishedEndpointName = version.endpointName;
      next.lastPublishedAt = next.updatedAt = publishedAt;
      next.publishedVersions.unshift({ ...version, versionId, publishedAt, isStarred: false, comment: '' });
      next.publicationVersion = nextPublicationVersion(before.publicationVersion);
      next.endpointStatus = this.#status(next);
      await this.#commit(structure, [{ before, after: next }]);
      return next;
    });
    return {
      project: this.#item(snapshot),
      version: this.#versionSummary(snapshot, this.#version(snapshot, snapshot.publishedVersionId)),
    };
  }
  #execution(
    snapshot: Pick<LocalExecutionSnapshot, 'workflowId' | 'relativePath' | 'endpointAccess' | 'cacheStatus'>,
    contents: string,
    datasetsContents: string | null,
  ) {
    const [project, attachedData] = loadProjectAndAttachedDataFromString(contents);
    if (project.metadata.id !== snapshot.workflowId)
      throw new Error('Execution project identity does not match catalog.');
    return {
      project,
      attachedData,
      datasetProvider: new NodeDatasetProvider(datasetsContents ? deserializeDatasets(datasetsContents) : []),
      projectVirtualPath: this.#absolute(snapshot.relativePath),
      revisionKey: `sqlite:${revision({ contents, datasetsContents })}`,
      endpointAccess: snapshot.endpointAccess,
      debug: { cacheStatus: snapshot.cacheStatus ?? ('bypass' as const), resolveMs: 0, materializeMs: 0 },
    };
  }
  async loadPublishedExecutionProject(name: string) {
    return this.#loadEndpoint(name, 'published');
  }
  async loadLatestExecutionProject(name: string) {
    return this.#loadEndpoint(name, 'latest');
  }
  async #loadEndpoint(name: string, version: 'published' | 'latest') {
    const snapshot = await this.#catalog.readExecutionSource(
      { endpointName: normalizeWorkflowEndpointLookupName(name), version },
      this.#readOnly ? undefined : this.#executionCache,
    );
    return snapshot ? this.#execution(snapshot, snapshot.contents, snapshot.datasetsContents) : null;
  }
  async #loadApp(slug: string, latest: boolean) {
    const snapshot = await this.#catalog.readExecutionSource(
      { webAppSlug: normalizeWorkflowEndpointLookupName(slug), version: latest ? 'latest' : 'published' },
      this.#readOnly ? undefined : this.#executionCache,
    );
    if (!snapshot?.webApp) return null;
    const app = snapshot.webApp;
    return {
      ...this.#execution(snapshot, snapshot.contents, snapshot.datasetsContents),
      webAppUiGraphId: app.uiGraphId,
      webAppAllowedEmails: app.allowedEmails,
      webAppBindingId: `filesystem:${app.appId}`,
      webAppPolicyInvalidationKey: `filesystem:${this.#absolute(snapshot.relativePath)}`,
    };
  }
  loadPublishedWebAppExecutionProject(slug: string) {
    return this.#loadApp(slug, false);
  }
  loadLatestWebAppExecutionProject(slug: string) {
    return this.#loadApp(slug, true);
  }
  async resolveWebAppAccessPolicy(slug: string) {
    const match = this.#catalog.readWebAppPolicy(normalizeWorkflowEndpointLookupName(slug));
    if (!match?.webApp) return null;
    return {
      projectVirtualPath: this.#absolute(match.relativePath),
      relativePath: match.relativePath,
      appId: match.webApp.appId,
      uiGraphId: match.webApp.uiGraphId,
      allowedEmails: match.webApp.allowedEmails,
      bindingId: `filesystem:${match.webApp.appId}`,
    };
  }
  async readHostedText(filePath: string): Promise<string> {
    const dataset = filePath.endsWith('.rivet-data');
    const projectPath = dataset ? `${filePath.slice(0, -'.rivet-data'.length)}.rivet-project` : filePath;
    const snapshot = await this.#payload(this.#parseAbsolute(projectPath));
    if (dataset && snapshot.datasetsContents === null) throw createHttpError(404, 'Dataset not found');
    return dataset ? snapshot.datasetsContents! : snapshot.contents!;
  }
  async hostedPathExists(filePath: string): Promise<boolean> {
    const dataset = filePath.endsWith('.rivet-data');
    const projectPath = dataset ? `${filePath.slice(0, -'.rivet-data'.length)}.rivet-project` : filePath;
    return this.#catalog.hasProjectArtifact(this.#parseAbsolute(projectPath), dataset);
  }

  async resolveManagedRelativeProjectText(currentPath: string, reference: string): Promise<string> {
    const base = this.#parseAbsolute(currentPath);
    const resolved = path.posix.normalize(path.posix.join(parentOf(base), reference));
    return (await this.#payload(resolved)).contents!;
  }

  createProjectReferenceLoader() {
    return {
      loadProject: async (
        _currentPath: string | undefined,
        reference: { id: string; hintPaths?: string[]; title?: string },
      ) => {
        // Stable identity is authoritative, not stale or spoofed path hints.
        const { id } = reference;
        const projectPath = this.#catalog.findProjectPathById(id);
        if (!projectPath) throw createHttpError(404, 'Referenced project not found');
        const snapshot = await this.#payload(projectPath, 'published-or-latest');
        const [project] = loadProjectAndAttachedDataFromString(snapshot.contents!);
        if (project.metadata.id !== id) throw new Error('Referenced project identity does not match catalog');
        return project;
      },
    };
  }

  async loadSubgraphTarget(target: SubgraphProjectTarget): Promise<ResolvedSubgraphProject> {
    const { projectId, version } = target;
    const projectPath = this.#catalog.findProjectPathById(projectId);
    if (!projectPath) throw createHttpError(404, 'Subgraph project not found');
    const snapshot = await this.#payload(projectPath, version);
    const { contents, datasetsContents } = snapshot;
    if (contents === null) throw conflict('Subgraph project has no published version');
    const execution = this.#execution(snapshot, contents, datasetsContents);
    if (execution.project.metadata.id !== projectId)
      throw new Error('Subgraph project identity does not match catalog');
    return {
      project: execution.project,
      datasetProvider: execution.datasetProvider,
      revisionKey: execution.revisionKey,
      projectContents: contents,
      datasetsContents: datasetsContents ?? undefined,
      sourceProjectPath: execution.projectVirtualPath,
    };
  }

  async persistWorkflowExecutionRecording(
    options: PersistWorkflowExecutionRecordingOptions,
  ): Promise<string | undefined> {
    const config = getWorkflowRecordingConfig();
    if (!config.enabled || !options.sourceProject.metadata.id) return undefined;
    const onPersisted = options.onPersisted;
    const saved = structuredClone({ ...options, onPersisted: undefined });
    const id = `${Date.now()}-${randomUUID()}`;
    await this.#withWrite(async () => {
      if (!this.#catalog.findProjectPathById(saved.sourceProject.metadata.id))
        throw conflict('Recording source project no longer exists');
      const replay = {
        ...saved.executedProject,
        metadata: { ...saved.executedProject.metadata, id: randomUUID() as Project['metadata']['id'] },
      };
      const replayContents = serializeProject(replay, saved.executedAttachedData);
      if (typeof replayContents !== 'string') throw new Error('Serialized replay project is not a string');
      await this.#catalog.importRecording(
        {
          recordingId: id,
          workflowId: saved.sourceProject.metadata.id,
          sourceProjectRelativePath: this.#parseAbsolute(saved.sourceProjectPath),
          sourceProjectName: saved.sourceProject.metadata.title,
          createdAt: new Date().toISOString(),
          runKind: saved.runKind,
          status: saved.status,
          durationMs: saved.durationMs,
          endpointName: saved.endpointName,
          errorMessage: saved.errorMessage ?? null,
          executionIdentity: saved.executionIdentity,
          recordingContents: saved.recordingSerialized,
          replayProjectContents: replayContents,
          replayDatasetContents:
            config.datasetMode === 'all' && saved.executedDatasets.length
              ? serializeDatasets(saved.executedDatasets)
              : null,
        },
        { compression: config.compression, gzipLevel: config.gzipLevel },
      );
      await onPersisted?.(id);
    });
    return id;
  }

  async readWorkflowRecordingArtifact(
    id: string,
    artifact: 'recording' | 'replay-project' | 'replay-dataset',
  ): Promise<string> {
    const contents = await this.#catalog.readRecordingArtifact(id, artifact);
    if (contents === null) throw createHttpError(404, 'Recording artifact not found');
    return contents;
  }

  async deleteWorkflowRecording(id: string): Promise<void> {
    await this.#withWrite(async () => {
      const row = this.#catalog.listRecordingMetadata({ recordingId: id, limit: 1 })[0];
      if (!row) throw createHttpError(404, 'Recording not found');
      this.#catalog.deleteRecording(id);
      workflowRecordingInputCache.invalidate(`${this.#cacheScope}${row.recordingHash}`);
    });
  }

  async cleanupRecordings(options: { now?: number; batchSize?: number } = {}): Promise<number> {
    const now = options.now ?? Date.now();
    const batchSize = options.batchSize ?? 100;
    return this.#withWrite(async () => {
      const { retentionDays, maxRunsPerEndpoint, maxTotalBytes } = getWorkflowRecordingConfig();
      // An unreadable health authority must stop cleanup, never become an empty
      // hold set that discards the recording needed to diagnose a suspension.
      const heldRecordingIds = await this.#getRecordingRetentionHolds();
      const deleted = this.#catalog.pruneRecordings({
        now,
        batchSize,
        retentionDays,
        maxRunsPerEndpoint,
        maxTotalBytes,
        heldRecordingIds,
      });
      for (const row of deleted) workflowRecordingInputCache.invalidate(`${this.#cacheScope}${row.recordingHash}`);
      await this.#catalog.collectOrphanArtifacts({ now, batchSize });
      return deleted.length;
    });
  }

  #recordingSummary(row: LocalRecordingMetadata): WorkflowRecordingRunSummary {
    return {
      id: row.recordingId,
      workflowId: row.workflowId,
      sourceProjectName: row.sourceProjectName,
      sourceProjectRelativePath: row.sourceProjectRelativePath,
      createdAt: row.createdAt,
      runKind: row.runKind,
      status: row.status,
      durationMs: row.durationMs,
      endpointNameAtExecution: row.endpointName,
      executionIdentity: row.executionIdentity,
      errorMessage: row.errorMessage ?? undefined,
      hasReplayDataset: row.hasReplayDataset,
      recordingCompressedBytes: row.recordingBytes,
      recordingUncompressedBytes: row.recordingDecodedBytes,
      projectCompressedBytes: row.projectBytes,
      projectUncompressedBytes: row.projectDecodedBytes,
      datasetCompressedBytes: row.datasetBytes,
      datasetUncompressedBytes: row.datasetDecodedBytes,
    };
  }

  async listWorkflowRecordingRunsPage(
    workflowId: string,
    page: number,
    pageSize: number,
    statusFilter: WorkflowRecordingFilterStatus = 'all',
    inputFilter: WorkflowRecordingInputFilter | null = null,
    inputCursor = 0,
    signal?: AbortSignal,
    inputAfter?: string,
    includeSubgraphRuns = false,
    runScope: 'all' | 'roots' | 'children' = inputFilter ? 'roots' : 'all',
  ): Promise<WorkflowRecordingRunsPageResponse> {
    if (workflowId && runScope !== 'children' && !this.#catalog.findProjectPathById(workflowId))
      throw createHttpError(404, 'Project not found');
    const normalizedPage = Math.max(1, Math.floor(page)),
      size = Math.min(100, Math.max(1, Math.floor(pageSize)));
    if (
      ![normalizedPage, size, inputCursor].every(Number.isSafeInteger) ||
      inputCursor < 0 ||
      !['all', 'failed'].includes(statusFilter)
    )
      throw badRequest('Invalid recording page');
    const scopeCounts =
      (workflowId && includeSubgraphRuns) || runScope !== 'all'
        ? this.#catalog.recordingScopeCounts(workflowId, runScope)
        : undefined;
    const scope = inputFilter ? { workflowId, statusFilter, filter: inputFilter, includeSubgraphRuns } : null;
    const load = async (after: string | undefined, offset: number, limit: number) =>
      this.#catalog.listRecordingMetadata({
        workflowId,
        includeSubgraphRuns,
        runScope,
        failedOnly: statusFilter === 'failed',
        limit,
        offset,
        after: scope ? parseWorkflowRecordingInputAfter(after, scope) : undefined,
      });
    const filtered = scope
      ? await filterRecordingInputWindows(
          scope.filter,
          load,
          (row, abort) =>
            workflowRecordingInputCache.getOrLoad(
              `${this.#cacheScope}${row.recordingHash}`,
              () => this.#catalog.readRecordingArtifact(row.recordingId, 'recording'),
              abort,
              row.recordingDecodedBytes,
            ),
          {
            pageSize: size,
            inputCursor,
            inputAfter,
            signal,
            getInputAfter: (row, cursor) =>
              createWorkflowRecordingInputAfter(
                { createdAt: row.createdAt, recordingId: row.recordingId, legacyCursor: cursor },
                scope,
              ),
          },
        )
      : null;
    const rows = filtered?.rows ?? (await load(undefined, (normalizedPage - 1) * size, size));
    const count =
      filtered?.totalRuns ??
      (scopeCounts
        ? statusFilter === 'failed'
          ? scopeCounts.failedRuns + scopeCounts.suspiciousRuns
          : scopeCounts.totalRuns
        : this.#catalog.countRecordings(workflowId, statusFilter === 'failed'));
    return {
      workflowId,
      scopeCounts,
      page: normalizedPage,
      pageSize: size,
      totalRuns: count,
      statusFilter,
      inputFilter,
      totalRunsExact: filtered?.totalRunsExact ?? true,
      hasMore: filtered?.hasMore ?? normalizedPage * size < count,
      inputSearchAnalyzedRuns: filtered?.analyzedRuns,
      nextInputCursor: filtered?.nextInputCursor,
      nextInputAfter: filtered?.nextInputAfter,
      runs: rows.map((row) => this.#recordingSummary(row)),
    };
  }

  async listWorkflowRecordingWorkflows() {
    const result = this.#catalog
      .readRecordingWorkflowProjection()
      .map(({ project, ...summary }) => ({ ...summary, project: this.#treeItem(project) }));
    result.sort((left, right) => left.project.relativePath.localeCompare(right.project.relativePath));
    return { workflows: result };
  }
  async listWorkflowRunStatisticsCatalog(surface: WorkflowRunStatisticsSurface) {
    return buildWorkflowRunStatisticsCatalog(this.#catalog.readRecordingStatisticsCatalog(surface), surface);
  }
  async getWorkflowRunStatistics(query: WorkflowRunStatisticsQuery) {
    return buildWorkflowRunStatistics(this.#catalog.readRecordingStatistics(query), query);
  }
}
