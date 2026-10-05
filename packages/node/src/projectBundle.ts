import {
  deserializeDatasets,
  loadProjectFromString,
  projectBundleTargetKey,
  validateProjectBundleManifest,
  type Project,
  type ProjectBundleFile,
  type ProjectBundleManifest,
  globalRivetNodeRegistry,
  validateProjectBundleProjects,
} from '@valerypopoff/rivet2-core';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createProcessor, type NodeCreatedProcessor, type NodeCreateProcessorOptions } from './api.js';
import { NodeDatasetProvider } from './native/NodeDatasetProvider.js';

export type NodeProjectBundleProcessorOptions = NodeCreateProcessorOptions & {
  projectPath?: never;
  datasetProvider?: never;
  projectReferenceLoader?: never;
  subgraphProjectLoader?: never;
};
export type NodeProjectBundle = {
  readonly manifest: ProjectBundleManifest;
  readonly root: Readonly<Project['metadata']>;
  createProcessor(options?: NodeProjectBundleProcessorOptions): NodeCreatedProcessor;
};

/** Loads an extracted bundle. Validation never executes project code or makes network requests. */
export async function loadProjectBundle(
  manifestPath: string,
  options: { maxTotalBytes?: number } = {},
): Promise<NodeProjectBundle> {
  const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('Invalid bundle byte limit.');
  const root = await fs.realpath(path.dirname(path.resolve(manifestPath)));
  const inside = (resolved: string) => {
    const relative = path.relative(root, resolved);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const read = async (relative: string, expected?: ProjectBundleFile): Promise<string> => {
    const location = path.resolve(root, relative);
    if (!inside(location) || !inside(await fs.realpath(location)))
      throw new Error(`Bundle path escapes its directory: ${relative}`);
    const handle = await fs.open(location, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > (expected?.bytes ?? 1024 * 1024) || (expected && stat.size !== expected.bytes))
        throw new Error(`Bundle file size mismatch: ${relative}`);
      // Read at most the captured size plus one overflow byte. A file growing after
      // stat must not cause readFile() to allocate beyond the validated byte limit.
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size) throw new Error(`Bundle file size mismatch: ${relative}`);
      const contents = buffer.subarray(0, length);
      if (
        expected &&
        (contents.length !== expected.bytes || createHash('sha256').update(contents).digest('hex') !== expected.sha256)
      )
        throw new Error(`Bundle checksum mismatch: ${relative}`);
      return contents.toString('utf8');
    } finally {
      await handle.close();
    }
  };
  const manifest = validateProjectBundleManifest(JSON.parse(await read(path.basename(manifestPath))));
  const totalBytes = manifest.artifacts.reduce((sum, a) => sum + a.project.bytes + (a.datasets?.bytes ?? 0), 0);
  if (totalBytes > maxTotalBytes)
    throw new Error(`Bundle exceeds the ${maxTotalBytes} byte limit. Increase maxTotalBytes deliberately if needed.`);
  const snapshots = new Map<
    string,
    { project: Project; datasets: ReturnType<typeof deserializeDatasets>; projectPath: string }
  >();
  for (const artifact of manifest.artifacts) {
    const project = loadProjectFromString(await read(artifact.project.path, artifact.project));
    if (project.metadata.id !== artifact.projectId) throw new Error(`Bundle project identity mismatch: ${artifact.id}`);
    const datasets = artifact.datasets
      ? deserializeDatasets(await read(artifact.datasets.path, artifact.datasets))
      : [];
    snapshots.set(artifact.id, { project, datasets, projectPath: path.join(root, artifact.project.path) });
  }
  const targets = new Map(manifest.targets.map((t) => [projectBundleTargetKey(t.projectId, t.version), t.artifact]));
  const references = new Map(manifest.references.map((r) => [r.projectId, r.artifact]));
  validateProjectBundleProjects(manifest, new Map([...snapshots].map(([id, snapshot]) => [id, snapshot.project])));
  return {
    manifest: structuredClone(manifest),
    root: structuredClone(snapshots.get(manifest.rootArtifact)!.project.metadata),
    createProcessor(processorOptions = {}) {
      for (const key of ['projectPath', 'datasetProvider', 'projectReferenceLoader', 'subgraphProjectLoader']) {
        if (Object.hasOwn(processorOptions, key))
          throw new Error(`Bundle owns ${key}; remove the conflicting override.`);
      }
      // One mutable copy/provider per artifact per processor, never per loader or project ID.
      const runtime = new Map(
        [...snapshots].map(([id, snapshot]) => [
          id,
          {
            project: structuredClone(snapshot.project),
            datasetProvider: new NodeDatasetProvider(structuredClone(snapshot.datasets)),
            sourceProjectPath: snapshot.projectPath,
            revisionKey: manifest.artifacts.find((a) => a.id === id)!.revision,
          },
        ]),
      );
      const rootSnapshot = runtime.get(manifest.rootArtifact)!;
      const providersByProject = new Map(
        [...runtime.values()].map((snapshot) => [snapshot.project, snapshot.datasetProvider]),
      );
      const registered = new Set(
        (processorOptions.registry ?? globalRivetNodeRegistry).getPlugins().map((plugin) => plugin.id),
      );
      for (const spec of manifest.plugins) {
        if ((processorOptions.registry || spec.type !== 'built-in') && !registered.has(spec.id))
          throw new Error(
            `Bundle requires plugin ${spec.id}. Install it locally and pass its registered registry; bundles never install plugins automatically.`,
          );
      }
      rootSnapshot.project.plugins = structuredClone(manifest.plugins);
      return createProcessor(rootSnapshot.project, {
        ...processorOptions,
        projectPath: rootSnapshot.sourceProjectPath,
        datasetProvider: rootSnapshot.datasetProvider,
        projectReferenceLoader: {
          getDatasetProvider: (project) => providersByProject.get(project),
          async loadProject(_currentPath, reference) {
            const id = references.get(reference.id);
            if (!id) throw new Error(`Bundle has no reference binding for ${reference.id}`);
            return runtime.get(id)!.project;
          },
        },
        subgraphProjectLoader: {
          async loadTarget(target) {
            const id = targets.get(projectBundleTargetKey(target.projectId, target.version));
            if (!id) throw new Error(`Bundle has no target binding for ${target.projectId}:${target.version}`);
            return runtime.get(id)!;
          },
        },
      });
    },
  };
}
