import {
  createProjectBundleRuntime,
  deserializeDatasets,
  deserializeProject,
  validateProjectBundleManifest,
  type DatasetProvider,
  type Project,
  type ProjectBundleSnapshot,
} from '@valerypopoff/rivet2-core';
import { invokeNative } from '../utils/platform/core.js';
import { parseDatasetsFileContents } from './datasets.js';

export type NativeProjectBundle = {
  manifestPath: string;
  manifestContents: string;
  selectedProjectPath: string | null;
  files: { path: string; contents: string; sourceProjectPath: string }[];
};

/** Native owns contained, bounded filesystem reads; Core owns bundle semantics. No checksums or filename guessing. */
export function prepareDesktopProjectBundle(input: NativeProjectBundle) {
  const manifest = validateProjectBundleManifest(JSON.parse(input.manifestContents));
  const files = new Map(input.files.map((file) => [file.path, file]));
  const artifactId =
    input.selectedProjectPath == null
      ? manifest.rootArtifact
      : manifest.artifacts.find(
          (artifact) => files.get(artifact.project.path)?.sourceProjectPath === input.selectedProjectPath,
        )?.id;
  if (!artifactId) throw new Error('The selected project is not listed in rivet-bundle.json.');
  const openWorkspace = input.selectedProjectPath == null;
  if (
    openWorkspace &&
    new Set(manifest.artifacts.map((artifact) => artifact.projectId)).size !== manifest.artifacts.length
  )
    throw new Error(
      'This older bundle contains multiple versions of a project. Export it again with one bundle version selection, or open an individual member.',
    );
  const snapshots = new Map<string, ProjectBundleSnapshot>();
  const workspaceProjects: {
    path: string;
    project: Project;
    datasets: ProjectBundleSnapshot['datasets'];
    attachments: Record<string, unknown>;
    evaluationDatasets: ReturnType<typeof parseDatasetsFileContents>['evaluationDatasets'];
  }[] = [];
  let attachments: Record<string, unknown> = {};
  let evaluationDatasets: ReturnType<typeof parseDatasetsFileContents>['evaluationDatasets'] = [];
  for (const artifact of manifest.artifacts) {
    const file = files.get(artifact.project.path);
    if (!file) throw new Error(`Bundle is missing project file ${artifact.project.path}.`);
    const [project, attached] = deserializeProject(file.contents, file.sourceProjectPath);
    if (project.metadata.id !== artifact.projectId)
      throw new Error(`Bundle project identity mismatch: ${artifact.id}.`);
    let datasets = [] as ReturnType<typeof deserializeDatasets>;
    let memberEvaluationDatasets: typeof evaluationDatasets = [];
    if (artifact.datasets) {
      const datasetFile = files.get(artifact.datasets.path);
      if (!datasetFile) throw new Error(`Bundle is missing dataset file ${artifact.datasets.path}.`);
      if (artifact.id === artifactId || openWorkspace) {
        const parsed = parseDatasetsFileContents(datasetFile.contents, project);
        datasets = parsed.datasets;
        memberEvaluationDatasets = parsed.evaluationDatasets;
      } else {
        datasets = deserializeDatasets(datasetFile.contents);
      }
    }
    snapshots.set(artifact.id, { project, datasets, sourceProjectPath: file.sourceProjectPath });
    if (openWorkspace)
      workspaceProjects.push({
        path: file.sourceProjectPath,
        project,
        datasets,
        attachments: attached,
        evaluationDatasets: memberEvaluationDatasets,
      });
    if (artifact.id === artifactId) {
      attachments = attached;
      evaluationDatasets = memberEvaluationDatasets;
    }
  }
  const snapshot = snapshots.get(artifactId)!;
  return {
    manifest,
    manifestPath: input.manifestPath,
    artifactId,
    snapshot,
    snapshots,
    attachments,
    evaluationDatasets,
    workspaceProjects: openWorkspace ? workspaceProjects : undefined,
    createRuntime: (project: Project, datasetProvider?: DatasetProvider) =>
      createProjectBundleRuntime(manifest, snapshots, { artifactId, project, datasetProvider }),
  };
}

export async function readDesktopProjectBundle(projectPath: string, bundleManifestPath?: string) {
  const input = await invokeNative<NativeProjectBundle | null>('read_project_bundle', {
    projectFilePath: projectPath,
    ...(bundleManifestPath ? { bundleManifestPath } : {}),
  });
  if (bundleManifestPath && !input)
    throw new Error('The opened bundle could not be loaded. Reopen rivet-bundle.json before running it.');
  return input ? prepareDesktopProjectBundle(input) : undefined;
}

/** A known bundle must never fall through to execution without its loader. */
export async function readProjectBundleForExecution(
  io: { readProjectBundle?: typeof readDesktopProjectBundle },
  projectPath: string | null | undefined,
  bundleManifestPath?: string,
) {
  if (bundleManifestPath && (!io.readProjectBundle || !projectPath))
    throw new Error('The opened bundle has no local project location. Reopen rivet-bundle.json before running it.');
  const bundle =
    io.readProjectBundle && projectPath ? await io.readProjectBundle(projectPath, bundleManifestPath) : undefined;
  if (bundleManifestPath && !bundle)
    throw new Error('The opened bundle could not be loaded. Reopen rivet-bundle.json before running it.');
  return bundle;
}
