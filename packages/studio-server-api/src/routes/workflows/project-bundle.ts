import { hasWorkflowFailure } from './workflow-failure.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  PROJECT_BUNDLE_MANIFEST,
  ProjectBundleError,
  PROJECT_BUNDLE_MAX_ARTIFACTS,
  PROJECT_BUNDLE_MAX_MANIFEST_BYTES,
  listProjectBundleCalls,
  loadProjectFromString,
  projectBundleTargetKey,
  validateProjectBundleManifest,
  validateProjectBundleCall,
  validateProjectBundleProjects,
  serializeDatasets,
  type ProjectBundleArtifact,
  type ProjectBundleFile,
  type ProjectBundleManifest,
  type ResolvedSubgraphProject,
  type SubgraphProjectTarget,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import {
  createExecutionSubgraphProjectLoader,
  readWorkflowProjectDownloadWithBackend,
  getExplicitBundleService,
} from './storage-backend.js';
import type { WorkflowProjectDownloadVersion } from '../../../../studio-server-shared/workflow-types.js';
import { PROJECT_BUNDLE_UPLOAD_MAX_BYTES } from '../../../../studio-server-shared/project-bundle-types.js';
import { createHttpError } from '../../utils/httpError.js';

export type BundleSnapshot = ResolvedSubgraphProject & {
  projectContents: string;
  selectedVersion: 'latest' | 'published';
};
export type BundleSource = {
  versionPolicy?: 'latest' | 'published';
  prepare?(): Promise<void>;
  workspace?: ProjectBundleManifest['workspace'];
  additionalRoots?(): AsyncIterable<BundleSnapshot>;
  verify?(): Promise<void>;
  validateTarget?(target: SubgraphProjectTarget): Promise<void>;
  root(): Promise<BundleSnapshot>;
  target(target: SubgraphProjectTarget): Promise<BundleSnapshot>;
  reference(projectId: string): Promise<BundleSnapshot>;
};

/** Reuses the existing closure collector, seeded by every explicit member. */
export function createExplicitBundleSource(bundleId: string, version: 'latest' | 'published'): BundleSource {
  let workspace: ProjectBundleManifest['workspace'];
  const initialize = async () => {
    const service = await getExplicitBundleService();
    const snapshot = await service.exportSnapshot(bundleId, version);
    workspace = { name: snapshot.name, folders: snapshot.folders, members: snapshot.members };
    const source = createSavedBundleSource(
      snapshot.firstProjectPath,
      version === 'latest' ? 'live' : 'published',
      version,
    );
    return { service, snapshot, source };
  };
  let preparation: ReturnType<typeof initialize> | undefined;
  const ready = () => (preparation ??= initialize());
  return {
    versionPolicy: version,
    get workspace() {
      return workspace;
    },
    async prepare() {
      await ready();
    },
    async root() {
      return (await ready()).source.root();
    },
    async target(target) {
      return (await ready()).source.target(target);
    },
    async validateTarget(target) {
      await (await ready()).source.validateTarget?.(target);
    },
    async reference(id) {
      return (await ready()).source.reference(id);
    },
    async *additionalRoots() {
      const { snapshot, source } = await ready();
      for (const member of snapshot.members.slice(1)) yield await source.reference(member.projectId);
    },
    async verify() {
      const { service, snapshot } = await ready();
      if ((await service.exportSnapshot(bundleId, version)).fingerprint !== snapshot.fingerprint)
        throw new ProjectBundleError('Bundle membership or saved content changed while exporting. Retry the export.');
    },
  };
}
export const DEFAULT_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;
// Resolve the installed runtime's metadata, not the checkout's package.json.
const runtimeEntry = createRequire(import.meta.url).resolve('@valerypopoff/rivet2-node');
const exportingRuntimeVersion: string = JSON.parse(
  readFileSync(path.resolve(path.dirname(runtimeEntry), '../../package.json'), 'utf8'),
).version;

function abortableRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Export cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve()
      .then(read)
      .then((value) => {
        if (!signal.aborted) resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Adapter reuses saved execution snapshots for every backend, including matching datasets. */
export function createSavedBundleSource(
  relativePath: string,
  version: WorkflowProjectDownloadVersion,
  versionPolicy?: 'latest' | 'published',
): BundleSource {
  const loader = createExecutionSubgraphProjectLoader();
  const target = async (requested: SubgraphProjectTarget): Promise<BundleSnapshot> => {
    const selection = { ...requested, version: versionPolicy ?? requested.version };
    let snapshot;
    try {
      snapshot = await loader.loadTarget(selection);
    } catch (error) {
      if (versionPolicy !== 'published' || !hasWorkflowFailure(error, 'workflow_publication_missing')) throw error;
      selection.version = 'latest';
      snapshot = await loader.loadTarget(selection);
    }
    if (snapshot.projectContents === undefined) throw new Error('Saved project snapshot is unavailable.');
    return { ...snapshot, projectContents: snapshot.projectContents, selectedVersion: selection.version };
  };
  return {
    versionPolicy,
    validateTarget: (target) => loader.validateTarget(target),
    async root() {
      let download = await readWorkflowProjectDownloadWithBackend(relativePath, versionPolicy ? 'live' : version);
      const project = loadProjectFromString(download.contents);
      const snapshot = await target({
        projectId: project.metadata.id,
        version: version === 'live' ? 'latest' : 'published',
      });
      if (versionPolicy && snapshot.selectedVersion === 'published')
        download = await readWorkflowProjectDownloadWithBackend(relativePath, 'published');
      if (snapshot.projectContents !== download.contents)
        throw createHttpError(409, 'Project changed while exporting. Retry the export.');
      return snapshot;
    },
    target,
    async reference(projectId) {
      if (versionPolicy) return target({ projectId: projectId as ProjectId, version: versionPolicy });
      try {
        return await target({ projectId: projectId as ProjectId, version: 'published' });
      } catch (error) {
        if (!hasWorkflowFailure(error, 'workflow_publication_missing')) throw error;
        return target({ projectId: projectId as ProjectId, version: 'latest' });
      }
    },
  };
}

const identity = (snapshot: BundleSnapshot) =>
  createHash('sha256')
    .update(JSON.stringify([snapshot.project.metadata.id, snapshot.selectedVersion, snapshot.revisionKey ?? null]))
    .update('\0')
    .update(snapshot.projectContents)
    .update(snapshot.datasetsContents === undefined ? '\0absent' : '\0present')
    .update(snapshot.datasetsContents ?? '')
    .digest('hex');

/** Captures one immutable closure, then exposes a revalidation barrier before publication. */
export async function collectProjectBundle(options: {
  source: BundleSource;
  rootVersion: 'latest' | 'published';
  signal: AbortSignal;
  maxBytes?: number;
  writeFile(file: string, contents: string): Promise<void>;
  progress(phase: string, projects: number, bytes: number): void;
}): Promise<{ manifest: ProjectBundleManifest; verify(): Promise<void> }> {
  const { signal } = options;
  if (options.source.prepare) await abortableRead(() => options.source.prepare!(), signal);
  signal.throwIfAborted();
  const readSnapshot = async (read: () => Promise<BundleSnapshot>) => {
    const captured = await abortableRead(read, signal);
    // Capture primitive bytes and reparse them; never retain a source/cache-owned mutable Project.
    return {
      projectContents: captured.projectContents,
      datasetsContents: captured.datasetsContents,
      selectedVersion: captured.selectedVersion,
      revisionKey: captured.revisionKey,
      sourceProjectPath: captured.sourceProjectPath,
      project: loadProjectFromString(captured.projectContents),
    };
  };
  const source: BundleSource = {
    root: () => readSnapshot(() => options.source.root()),
    target: async (target) => {
      const snapshot = await readSnapshot(() => options.source.target(target));
      if (
        snapshot.project.metadata.id !== target.projectId ||
        (options.source.versionPolicy === undefined && snapshot.selectedVersion !== target.version) ||
        (options.source.versionPolicy === 'latest' && snapshot.selectedVersion !== 'latest')
      )
        throw new ProjectBundleError('Subgraph dependency resolved to the wrong project or version.');
      return snapshot;
    },
    reference: (id) => readSnapshot(() => options.source.reference(id)),
  };
  const manifest: ProjectBundleManifest = {
    format: 'rivet-project-bundle',
    schemaVersion: 1,
    requiredLoaderVersion: options.source.workspace ? 4 : options.source.versionPolicy ? 3 : 2,
    ...(options.source.workspace ? { workspace: options.source.workspace } : {}),
    ...(options.source.versionPolicy ? { versionPolicy: options.source.versionPolicy } : {}),
    exportingRuntimeVersion,
    rootArtifact: '',
    artifacts: [],
    targets: [],
    references: [],
    plugins: [],
  };
  const byTarget = new Map<string, ProjectBundleArtifact>();
  const byProject = new Map<string, ProjectBundleArtifact>();
  const capturedIdentities = new Map<string, string>();
  const checks: { fingerprint: string; read(): Promise<BundleSnapshot> }[] = [];
  const accessChecks: SubgraphProjectTarget[] = [];
  // Keep graph definitions for closure validation, but release raw project and
  // dataset strings once consumed by the writer. Do not retain every dataset in RAM.
  const snapshots = new Map<string, Pick<BundleSnapshot, 'project' | 'selectedVersion'>>();
  const references = new Set<string>();
  const pluginSpecs = new Set<string>();
  let totalBytes = 0;
  const file = async (location: string, contents: string): Promise<ProjectBundleFile> => {
    signal.throwIfAborted();
    const bytes = Buffer.byteLength(contents);
    totalBytes += bytes;
    if (
      bytes > 64 * 1024 * 1024 ||
      totalBytes >
        (manifest.workspace
          ? Math.min(options.maxBytes ?? DEFAULT_BUNDLE_MAX_BYTES, PROJECT_BUNDLE_UPLOAD_MAX_BYTES)
          : options.maxBytes ?? DEFAULT_BUNDLE_MAX_BYTES)
    )
      throw new ProjectBundleError('Project bundle exceeds the configured size limit (64 MiB per artifact file).');
    await options.writeFile(location, contents);
    return { path: location };
  };
  const add = async (
    snapshot: BundleSnapshot,
    version: 'latest' | 'published',
    read: () => Promise<BundleSnapshot>,
  ) => {
    signal.throwIfAborted();
    const key = projectBundleTargetKey(snapshot.project.metadata.id, version);
    const fingerprint = identity(snapshot);
    const existing = byTarget.get(key);
    if (existing) {
      if (capturedIdentities.get(key) !== fingerprint)
        throw new ProjectBundleError('A project changed while collecting dependencies. Retry the export.');
      checks.push({ fingerprint, read });
      return existing;
    }
    if (manifest.artifacts.length >= PROJECT_BUNDLE_MAX_ARTIFACTS)
      throw new ProjectBundleError('Project bundle exceeds 256 project snapshots.');
    const id = `a${manifest.artifacts.length.toString().padStart(4, '0')}`;
    const artifact: ProjectBundleArtifact = {
      id,
      projectId: snapshot.project.metadata.id,
      title: snapshot.project.metadata.title || snapshot.project.metadata.id,
      version,
      revision: snapshot.revisionKey ?? fingerprint,
      project: await file(`projects/${id}.rivet-project`, snapshot.projectContents),
      ...(snapshot.datasetsContents === undefined && !manifest.workspace
        ? {}
        : { datasets: await file(`projects/${id}.rivet-data`, snapshot.datasetsContents ?? serializeDatasets([])) }),
    };
    manifest.artifacts.push(artifact);
    for (const bindingVersion of manifest.versionPolicy ? (['latest', 'published'] as const) : [version])
      manifest.targets.push({ projectId: artifact.projectId, version: bindingVersion, artifact: id });
    byTarget.set(key, artifact);
    byProject.set(artifact.projectId, artifact);
    capturedIdentities.set(key, fingerprint);
    checks.push({ fingerprint, read });
    snapshots.set(id, { project: snapshot.project, selectedVersion: snapshot.selectedVersion });
    for (const plugin of snapshot.project.plugins ?? []) {
      const serialized = JSON.stringify(plugin);
      if (!pluginSpecs.has(serialized)) {
        pluginSpecs.add(serialized);
        manifest.plugins.push(plugin);
      }
    }
    options.progress('collecting', manifest.artifacts.length, totalBytes);
    return artifact;
  };
  {
    const root = await source.root();
    if (!manifest.versionPolicy && root.selectedVersion !== options.rootVersion)
      throw new ProjectBundleError('Subgraph root snapshot resolved to the wrong version.');
    manifest.rootArtifact = (await add(root, root.selectedVersion, source.root)).id;
    // An old reference to the active root is already fulfilled by its in-memory snapshot.
    references.add(root.project.metadata.id);
    manifest.references.push({ projectId: root.project.metadata.id, artifact: manifest.rootArtifact });
  }
  if (options.source.additionalRoots) {
    for await (const additional of options.source.additionalRoots()) {
      const snapshot = await readSnapshot(async () => additional);
      const projectId = snapshot.project.metadata.id;
      await add(snapshot, snapshot.selectedVersion, () => source.reference(projectId));
    }
  }
  // Map iteration also visits snapshots captured below, so it owns the traversal queue.
  for (const snapshot of snapshots.values()) {
    signal.throwIfAborted();
    const owner = byTarget.get(projectBundleTargetKey(snapshot.project.metadata.id, snapshot.selectedVersion))!;
    for (const call of listProjectBundleCalls(snapshot.project)) {
      const requested = {
        projectId: call.projectId as ProjectId,
        version: call.version,
        callerProjectId: snapshot.project.metadata.id,
      };
      await options.source.validateTarget?.(requested);
      accessChecks.push(requested);
      const key = projectBundleTargetKey(call.projectId, call.version);
      let artifact = manifest.versionPolicy ? byProject.get(call.projectId) : byTarget.get(key);
      if (!artifact) {
        try {
          const resolved = await source.target(requested);
          artifact = await add(resolved, resolved.selectedVersion, () => source.target(requested));
        } catch (error) {
          throw new ProjectBundleError(
            `Dependency ${owner.title} → ${call.projectId} (${call.version}) could not be captured.`,
            {
              cause: error,
            },
          );
        }
      }
      validateProjectBundleCall(call, snapshots.get(artifact.id)!.project);
    }
    for (const reference of snapshot.project.references ?? []) {
      if (references.has(reference.id)) continue;
      references.add(reference.id);
      const selected = manifest.versionPolicy ? byProject.get(reference.id) : undefined;
      if (selected) {
        manifest.references.push({ projectId: reference.id, artifact: selected.id });
        continue;
      }
      let resolved: BundleSnapshot;
      try {
        resolved = await source.reference(reference.id);
      } catch (error) {
        throw new ProjectBundleError(
          `Referenced project ${owner.title} → ${reference.title || reference.id} could not be captured.`,
          { cause: error },
        );
      }
      if (resolved.project.metadata.id !== reference.id)
        throw new ProjectBundleError('Referenced project identity mismatch.');
      const artifact = await add(resolved, resolved.selectedVersion, () => source.reference(reference.id));
      manifest.references.push({ projectId: reference.id, artifact: artifact.id });
    }
  }
  const validated = validateProjectBundleManifest(manifest);
  validateProjectBundleProjects(validated, new Map([...snapshots].map(([id, snapshot]) => [id, snapshot.project])));
  const manifestContents = JSON.stringify(validated, null, 2);
  if (Buffer.byteLength(manifestContents) > PROJECT_BUNDLE_MAX_MANIFEST_BYTES)
    throw new ProjectBundleError(
      'Project bundle manifest exceeds the 1 MiB loader limit. Shorten project titles or reduce the dependency set.',
    );
  await options.writeFile(PROJECT_BUNDLE_MANIFEST, manifestContents);
  return {
    manifest: validated,
    async verify() {
      for (const target of accessChecks) {
        signal.throwIfAborted();
        await options.source.validateTarget?.(target);
      }
      for (const check of checks) {
        signal.throwIfAborted();
        if (identity(await check.read()) !== check.fingerprint)
          throw new ProjectBundleError('A project or dataset changed while exporting. Retry the export.');
      }
      await options.source.verify?.();
    },
  };
}
