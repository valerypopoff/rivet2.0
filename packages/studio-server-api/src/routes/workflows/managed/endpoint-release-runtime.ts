import {
  NodeDatasetProvider,
  type Project,
  type ProjectReferenceLoader,
  type SubgraphProjectLoader,
  type SubgraphProjectTarget,
} from '@valerypopoff/rivet2-node';
import { createHttpError } from '../../../utils/httpError.js';
import { getManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import type { WorkflowExecutionDefinition } from '../data-backend.js';
import type { ParsedExecutionCache } from '../parsed-execution-cache.js';
import { endpointReleaseTargetKey } from './endpoint-release-manifest.js';
import type { loadEndpointReleaseArtifacts, StoredEndpointRelease } from './endpoint-release-reader.js';

const releaseBusy = () => createHttpError(503, 'Captured endpoint revisions are busy loading. Try again shortly.');

/** Shares immutable release reads and bounds cold artifact I/O per repository. */
export class ColdEndpointReleases<T> {
  private readonly loads = new Map<string, Promise<T>>();
  private readonly waiters = new Set<() => boolean>();
  private active = 0;

  load(key: string, canWait: boolean, read: () => Promise<T>): Promise<T> {
    const pending = this.loads.get(key);
    if (pending) return pending;
    if (this.active >= 4 && (!canWait || this.waiters.size >= 28)) return Promise.reject(releaseBusy());
    const result = this.run(read).finally(() => this.loads.delete(key));
    this.loads.set(key, result);
    return result;
  }

  private async run(read: () => Promise<T>) {
    if (this.active < 4) this.active++;
    else await this.wait();
    try {
      return await read();
    } finally {
      this.release();
    }
  }

  private release() {
    for (const start of this.waiters) if (start()) return;
    this.active--;
  }

  private wait(): Promise<void> {
    const deadline = performance.now() + 1_000;
    return new Promise((resolve, reject) => {
      const expire = () => {
        this.waiters.delete(start);
        reject(releaseBusy());
      };
      const start = () => {
        clearTimeout(timer);
        if (performance.now() >= deadline) {
          expire();
          return false;
        }
        this.waiters.delete(start);
        resolve();
        return true;
      };
      const timer = setTimeout(expire, 1_000);
      this.waiters.add(start);
    });
  }
}

export function createPreparedEndpointRelease(
  release: StoredEndpointRelease,
  artifacts: Awaited<ReturnType<typeof loadEndpointReleaseArtifacts>>,
) {
  const { manifest, projects, targets } = release;

  return {
    root: { revisionId: manifest.rootArtifactId, ...artifacts.contents.get(manifest.rootArtifactId)! },
    projectId: projects.get(manifest.rootArtifactId)!.projectId,
    bytes: Math.max(1, artifacts.bytes + Buffer.byteLength(JSON.stringify(manifest))),
    createRunReferences(cache: ParsedExecutionCache): NonNullable<WorkflowExecutionDefinition['frozenReferences']> {
      const datasetsByProject = new WeakMap<Project, NodeDatasetProvider>();
      const materialize = (id: string) => {
        const metadata = projects.get(id)!;
        const contents = artifacts.contents.get(id)!;
        const materialized = cache.materialize({ revisionId: id, ...contents });
        const datasetProvider = new NodeDatasetProvider(materialized.datasets);
        datasetsByProject.set(materialized.project, datasetProvider);
        return {
          project: materialized.project,
          datasetProvider,
          revisionKey: `managed:${id}`,
          projectContents: contents.contents,
          datasetsContents: contents.datasetsContents ?? undefined,
          sourceProjectPath: getManagedWorkflowProjectVirtualPath(metadata.relativePath),
        };
      };
      const allowedTarget = (target: SubgraphProjectTarget) => {
        const binding = targets.get(endpointReleaseTargetKey(target.projectId, target.version));
        if (!binding || !target.callerProjectId || !binding.callerProjectIds.has(target.callerProjectId))
          throw createHttpError(503, 'The Subgraph target was not captured in this endpoint revision.');
        return binding.artifactId;
      };
      const subgraphProjectLoader: SubgraphProjectLoader = {
        async validateTarget(target) {
          allowedTarget(target);
        },
        async loadTarget(target) {
          return materialize(allowedTarget(target));
        },
      };
      const projectReferenceLoader: ProjectReferenceLoader = {
        async loadProject(_path, reference) {
          const binding = targets.get(endpointReleaseTargetKey(reference.id, 'project-reference'));
          if (!binding)
            throw createHttpError(503, 'The referenced project was not captured in this endpoint revision.');
          return materialize(binding.artifactId).project;
        },
        getDatasetProvider: (project) => datasetsByProject.get(project),
      };
      return { subgraphProjectLoader, projectReferenceLoader };
    },
  };
}
