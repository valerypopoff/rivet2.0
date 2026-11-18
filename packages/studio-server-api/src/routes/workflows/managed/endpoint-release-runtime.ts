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
