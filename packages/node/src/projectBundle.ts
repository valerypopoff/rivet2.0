import {
  deserializeDatasets,
  loadProjectFromString,
  createProjectBundleRuntime,
  validateProjectBundleManifest,
  PROJECT_BUNDLE_MAX_MANIFEST_BYTES,
  type Project,
  type ProjectBundleManifest,
  globalRivetNodeRegistry,
  validateProjectBundleProjects,
  type ProjectBundleSnapshot,
  type ProjectBundleRuntime,
  type DatasetProvider,
} from '@valerypopoff/rivet2-core';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createProcessor, type NodeCreatedProcessor, type NodeCreateProcessorOptions } from './api.js';

export type NodeProjectBundleProcessorOptions = NodeCreateProcessorOptions & {
  projectPath?: never;
  datasetProvider?: never;
  projectReferenceLoader?: never;
  subgraphProjectLoader?: never;
};
export type NodeProjectBundle = {
  readonly manifest: ProjectBundleManifest;
  readonly root: Readonly<Project['metadata']>;
  createExecutionContext(options?: {
    artifactId?: string;
    project?: Project;
    datasetProvider?: DatasetProvider;
  }): ProjectBundleRuntime;
  createProcessor(options?: NodeProjectBundleProcessorOptions): NodeCreatedProcessor;
};

/** Loads an extracted bundle. Validation never executes project code or makes network requests. */
export async function loadProjectBundle(
  manifestPath: string,
  options: { maxTotalBytes?: number; entry?: { artifactId: string; project: Project }; signal?: AbortSignal } = {},
): Promise<NodeProjectBundle> {
  options.signal?.throwIfAborted();
  const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('Invalid bundle byte limit.');
  const root = await fs.realpath(path.dirname(path.resolve(manifestPath)));
  options.signal?.throwIfAborted();
  const inside = (resolved: string) => {
    const relative = path.relative(root, resolved);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  let totalBytes = 0;
  const read = async (relative: string, artifact = false): Promise<string> => {
    options.signal?.throwIfAborted();
    const location = path.resolve(root, relative);
    const resolved = await fs.realpath(location);
    options.signal?.throwIfAborted();
    if (!inside(location) || !inside(resolved)) throw new Error(`Bundle path escapes its directory: ${relative}`);
    const handle = await fs.open(resolved, 'r');
    try {
      options.signal?.throwIfAborted();
      const stat = await handle.stat();
      options.signal?.throwIfAborted();
      if (!stat.isFile() || stat.size > (artifact ? 64 * 1024 * 1024 : PROJECT_BUNDLE_MAX_MANIFEST_BYTES))
        throw new Error(`Bundle file exceeds its size limit or is not a regular file: ${relative}`);
      if (artifact && stat.size > maxTotalBytes - totalBytes)
        throw new Error(
          `Bundle exceeds the ${maxTotalBytes} byte limit. Increase maxTotalBytes deliberately if needed.`,
        );
      // Read at most the captured size plus one overflow byte. A file growing after
      // stat must not cause readFile() to allocate beyond the validated byte limit.
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        options.signal?.throwIfAborted();
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw new Error(`Bundle file size mismatch during loading: ${relative}`);
      const contents = buffer.subarray(0, length);
      if (artifact) totalBytes += length;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(contents);
      } catch {
        throw new Error(`Bundle file is not valid UTF-8: ${relative}`);
      }
    } finally {
      await handle.close();
    }
  };
  const manifest = validateProjectBundleManifest(JSON.parse(await read(path.basename(manifestPath))));
  const snapshots = new Map<string, ProjectBundleSnapshot>();
  for (const artifact of manifest.artifacts) {
    options.signal?.throwIfAborted();
    const project = loadProjectFromString(await read(artifact.project.path, true));
    if (project.metadata.id !== artifact.projectId) throw new Error(`Bundle project identity mismatch: ${artifact.id}`);
    const datasets = artifact.datasets ? deserializeDatasets(await read(artifact.datasets.path, true)) : [];
    snapshots.set(artifact.id, { project, datasets, sourceProjectPath: path.join(root, artifact.project.path) });
  }
  if (options.entry) {
    const snapshot = snapshots.get(options.entry.artifactId);
    if (!snapshot || snapshot.project.metadata.id !== options.entry.project.metadata.id)
      throw new Error('The open project identity no longer matches its bundle entry.');
    snapshots.set(options.entry.artifactId, { ...snapshot, project: structuredClone(options.entry.project) });
  }
  validateProjectBundleProjects(manifest, new Map([...snapshots].map(([id, snapshot]) => [id, snapshot.project])));
  options.signal?.throwIfAborted();
  return {
    manifest: structuredClone(manifest),
    root: structuredClone(snapshots.get(manifest.rootArtifact)!.project.metadata),
    createExecutionContext: (executionOptions) => createProjectBundleRuntime(manifest, snapshots, executionOptions),
    createProcessor(processorOptions = {}) {
      for (const key of ['projectPath', 'datasetProvider', 'projectReferenceLoader', 'subgraphProjectLoader']) {
        if (Object.hasOwn(processorOptions, key))
          throw new Error(`Bundle owns ${key}; remove the conflicting override.`);
      }
      const runtime = createProjectBundleRuntime(manifest, snapshots);
      const registered = new Set(
        (processorOptions.registry ?? globalRivetNodeRegistry).getPlugins().map((plugin) => plugin.id),
      );
      for (const spec of manifest.plugins) {
        if ((processorOptions.registry || spec.type !== 'built-in') && !registered.has(spec.id))
          throw new Error(
            `Bundle requires plugin ${spec.id}. Install it locally and pass its registered registry; bundles never install plugins automatically.`,
          );
      }
      runtime.project.plugins = structuredClone(manifest.plugins);
      return createProcessor(runtime.project, {
        ...processorOptions,
        projectPath: runtime.projectPath,
        datasetProvider: runtime.datasetProvider,
        projectReferenceLoader: runtime.projectReferenceLoader,
        subgraphProjectLoader: runtime.subgraphProjectLoader,
      });
    },
  };
}
