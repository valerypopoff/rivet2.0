import { InMemoryDatasetProvider, type DatasetProvider } from '../integrations/DatasetProvider.js';
import type { CombinedDataset } from '../utils/index.js';
import type { Project } from './Project.js';
import type { ProjectReferenceLoader } from './ProjectReferenceLoader.js';
import type { SubgraphProjectLoader } from './SubgraphProjectTarget.js';
import {
  ProjectBundleError,
  projectBundleTargetKey,
  validateProjectBundleProjects,
  type ProjectBundleManifest,
} from './ProjectBundle.js';

export type ProjectBundleSnapshot = {
  project: Project;
  datasets: CombinedDataset[];
  sourceProjectPath?: string;
};
export type ProjectBundleRuntime = {
  project: Project;
  projectPath?: string;
  datasetProvider: DatasetProvider;
  projectReferenceLoader: ProjectReferenceLoader;
  subgraphProjectLoader: SubgraphProjectLoader;
};

/** One isolated dependency/data universe per run. The visible entry project may override its disk copy. */
export function createProjectBundleRuntime(
  manifest: ProjectBundleManifest,
  snapshots: ReadonlyMap<string, ProjectBundleSnapshot>,
  options: { artifactId?: string; project?: Project; datasetProvider?: DatasetProvider } = {},
): ProjectBundleRuntime {
  const entryId = options.artifactId ?? manifest.rootArtifact;
  const entry = manifest.artifacts.find((artifact) => artifact.id === entryId);
  if (!entry) throw new ProjectBundleError('The selected project is not a member of this bundle.');
  if (options.project && options.project.metadata.id !== entry.projectId)
    throw new ProjectBundleError('The open project identity no longer matches its bundle entry.');
  const runtime = new Map(
    manifest.artifacts.map((artifact) => {
      const snapshot = snapshots.get(artifact.id);
      if (!snapshot) throw new ProjectBundleError(`Bundle is missing artifact ${artifact.id}.`);
      const project = structuredClone(artifact.id === entryId && options.project ? options.project : snapshot.project);
      return [
        artifact.id,
        {
          project,
          sourceProjectPath: snapshot.sourceProjectPath,
          datasetProvider:
            artifact.id === entryId && options.datasetProvider
              ? options.datasetProvider
              : new InMemoryDatasetProvider(structuredClone(snapshot.datasets)),
        },
      ] as const;
    }),
  );
  validateProjectBundleProjects(manifest, new Map([...runtime].map(([id, snapshot]) => [id, snapshot.project])));
  const targets = new Map(
    manifest.targets.map((target) => [projectBundleTargetKey(target.projectId, target.version), target.artifact]),
  );
  const references = new Map(manifest.references.map((reference) => [reference.projectId, reference.artifact]));
  const providers = new Map([...runtime.values()].map((snapshot) => [snapshot.project, snapshot.datasetProvider]));
  const root = runtime.get(entryId)!;
  return {
    project: root.project,
    projectPath: root.sourceProjectPath,
    datasetProvider: root.datasetProvider,
    projectReferenceLoader: {
      getDatasetProvider: (project) => providers.get(project),
      async loadProject(_path, reference) {
        const id = references.get(reference.id);
        if (!id) throw new ProjectBundleError(`Bundle has no reference binding for ${reference.id}.`);
        return runtime.get(id)!.project;
      },
    },
    subgraphProjectLoader: {
      async loadTarget(target) {
        const id = targets.get(projectBundleTargetKey(target.projectId, target.version));
        if (!id)
          throw new ProjectBundleError(`Bundle has no target binding for ${target.projectId}:${target.version}.`);
        return runtime.get(id)!;
      },
    },
  };
}
