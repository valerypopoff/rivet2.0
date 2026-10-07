import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  PROJECT_BUNDLE_MANIFEST,
  ProjectBundleError,
  PROJECT_BUNDLE_MAX_ARTIFACTS,
  listProjectBundleCalls,
  loadProjectFromString,
  projectBundleTargetKey,
  validateProjectBundleManifest,
  validateProjectBundleCall,
  validateProjectBundleProjects,
  type ProjectBundleArtifact,
  type ProjectBundleFile,
  type ProjectBundleManifest,
  type ResolvedSubgraphProject,
  type SubgraphProjectTarget,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import { createExecutionSubgraphProjectLoader, readWorkflowProjectDownloadWithBackend } from './storage-backend.js';
import type { WorkflowProjectDownloadVersion } from '../../../../studio-server-shared/workflow-types.js';
import { createHttpError } from '../../utils/httpError.js';

export type BundleSnapshot = ResolvedSubgraphProject & {
  projectContents: string;
  selectedVersion: 'latest' | 'published';
};
export type BundleSource = {
  root(): Promise<BundleSnapshot>;
  target(target: SubgraphProjectTarget): Promise<BundleSnapshot>;
  reference(projectId: string): Promise<BundleSnapshot>;
};
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
export function createSavedBundleSource(relativePath: string, version: WorkflowProjectDownloadVersion): BundleSource {
  const loader = createExecutionSubgraphProjectLoader();
  const target = async (requested: SubgraphProjectTarget): Promise<BundleSnapshot> => {
    const snapshot = await loader.loadTarget(requested);
    if (snapshot.projectContents === undefined) throw new Error('Saved project snapshot is unavailable.');
    return { ...snapshot, projectContents: snapshot.projectContents, selectedVersion: requested.version };
  };
  return {
    async root() {
      const download = await readWorkflowProjectDownloadWithBackend(relativePath, version);
      const project = loadProjectFromString(download.contents);
      const snapshot = await target({
        projectId: project.metadata.id,
        version: version === 'live' ? 'latest' : 'published',
      });
      if (snapshot.projectContents !== download.contents)
        throw createHttpError(409, 'Project changed while exporting. Retry the export.');
      return snapshot;
    },
    target,
    async reference(projectId) {
      try {
        return await target({ projectId: projectId as ProjectId, version: 'published' });
      } catch (error) {
        if (
          (error as { status?: number }).status !== 409 ||
          !(error instanceof Error) ||
          !error.message.includes('no published version')
        )
          throw error;
        return target({ projectId: projectId as ProjectId, version: 'latest' });
      }
    },
  };
}

const digest = (contents: string) => createHash('sha256').update(contents).digest('hex');
const identity = (snapshot: BundleSnapshot) =>
  createHash('sha256')
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
      if (snapshot.project.metadata.id !== target.projectId || snapshot.selectedVersion !== target.version)
        throw new ProjectBundleError('Subgraph dependency resolved to the wrong project or version.');
      return snapshot;
    },
    reference: (id) => readSnapshot(() => options.source.reference(id)),
  };
  const manifest: ProjectBundleManifest = {
    format: 'rivet-project-bundle',
    schemaVersion: 1,
    requiredLoaderVersion: 1,
    exportingRuntimeVersion,
    rootArtifact: '',
    artifacts: [],
    targets: [],
    references: [],
    plugins: [],
  };
  const byTarget = new Map<string, ProjectBundleArtifact>();
  const checks: { fingerprint: string; read(): Promise<BundleSnapshot> }[] = [];
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
    if (bytes > 64 * 1024 * 1024 || totalBytes > (options.maxBytes ?? DEFAULT_BUNDLE_MAX_BYTES))
      throw new ProjectBundleError('Project bundle exceeds the configured size limit (64 MiB per artifact file).');
    await options.writeFile(location, contents);
    return { path: location, bytes, sha256: digest(contents) };
  };
  const add = async (
    snapshot: BundleSnapshot,
    version: 'latest' | 'published',
    read: () => Promise<BundleSnapshot>,
  ) => {
    signal.throwIfAborted();
    const key = projectBundleTargetKey(snapshot.project.metadata.id, version);
    const existing = byTarget.get(key);
    if (existing) {
      if (
        existing.project.sha256 !== digest(snapshot.projectContents) ||
        existing.datasets?.sha256 !==
          (snapshot.datasetsContents === undefined ? undefined : digest(snapshot.datasetsContents))
      )
        throw new ProjectBundleError('A project changed while collecting dependencies. Retry the export.');
      checks.push({ fingerprint: identity(snapshot), read });
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
      revision: snapshot.revisionKey ?? identity(snapshot),
      project: await file(`projects/${id}.rivet-project`, snapshot.projectContents),
      ...(snapshot.datasetsContents === undefined
        ? {}
        : { datasets: await file(`projects/${id}.rivet-data`, snapshot.datasetsContents) }),
    };
    manifest.artifacts.push(artifact);
    manifest.targets.push({ projectId: artifact.projectId, version, artifact: id });
    byTarget.set(key, artifact);
    checks.push({ fingerprint: identity(snapshot), read });
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
    if (root.selectedVersion !== options.rootVersion)
      throw new ProjectBundleError('Subgraph root snapshot resolved to the wrong version.');
    manifest.rootArtifact = (await add(root, options.rootVersion, source.root)).id;
    // An old reference to the active root is already fulfilled by its in-memory snapshot.
    references.add(root.project.metadata.id);
    manifest.references.push({ projectId: root.project.metadata.id, artifact: manifest.rootArtifact });
  }
  // Map iteration also visits snapshots captured below, so it owns the traversal queue.
  for (const snapshot of snapshots.values()) {
    signal.throwIfAborted();
    const owner = byTarget.get(projectBundleTargetKey(snapshot.project.metadata.id, snapshot.selectedVersion))!;
    for (const call of listProjectBundleCalls(snapshot.project)) {
      const key = projectBundleTargetKey(call.projectId, call.version);
      let artifact = byTarget.get(key);
      if (!artifact) {
        const requested = { projectId: call.projectId as ProjectId, version: call.version };
        try {
          artifact = await add(await source.target(requested), call.version, () => source.target(requested));
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
  await options.writeFile(PROJECT_BUNDLE_MANIFEST, JSON.stringify(validated, null, 2));
  return {
    manifest: validated,
    async verify() {
      for (const check of checks) {
        signal.throwIfAborted();
        if (identity(await check.read()) !== check.fingerprint)
          throw new ProjectBundleError('A project or dataset changed while exporting. Retry the export.');
      }
    },
  };
}
