import { type Project, deserializeDatasets, serializeDatasets } from '@valerypopoff/rivet2-core';
import { validateEvaluationDataset, type EvaluationDataset } from '@valerypopoff/rivet2-evaluations';
import { allowDataFileNeighbor } from '../utils/tauri.js';
import { type AppDatasetProvider, type PathPolicyProvider } from '../providers/ProvidersContext.js';
import { nativeExists, nativeReadTextFile, nativeWriteFile } from '../utils/platform/fs.js';

export async function saveDatasetsFile(
  projectFilePath: string,
  project: Project,
  datasetProvider: AppDatasetProvider,
  pathPolicy?: PathPolicyProvider,
) {
  const datasets = await datasetProvider.exportDatasetsForProject(project.metadata.id);
  await (pathPolicy?.allowDataFileNeighbor ?? allowDataFileNeighbor)(projectFilePath);

  const dataPath = projectFilePath.replace('.rivet-project', '.rivet-data');

  if (datasets.length > 0 || (await nativeExists(dataPath))) {
    const serializedDatasets = JSON.parse(serializeDatasets(datasets)) as { datasets: unknown };

    await nativeWriteFile({
      // Evaluation datasets were stored here by older Rivet builds. They are
      // migrated to the local library on open and intentionally never written
      // back into a project sidecar.
      contents: JSON.stringify(serializedDatasets),
      path: dataPath,
    });
  }
}

export async function loadDatasetsFile(
  projectFilePath: string,
  project: Project,
  datasetProvider: AppDatasetProvider,
  pathPolicy?: PathPolicyProvider,
): Promise<EvaluationDataset[]> {
  const { datasets, evaluationDatasets } = await readDatasetsFile(projectFilePath, project, pathPolicy);
  await datasetProvider.importDatasetsForProject?.(project.metadata.id, datasets);
  return evaluationDatasets;
}

/** Parse the sidecar without changing the selected project's dataset state. */
export async function readDatasetsFile(
  projectFilePath: string,
  project: Project,
  pathPolicy?: PathPolicyProvider,
): Promise<{ datasets: ReturnType<typeof deserializeDatasets>; evaluationDatasets: EvaluationDataset[] }> {
  await (pathPolicy?.allowDataFileNeighbor ?? allowDataFileNeighbor)(projectFilePath);

  const datasetsFilePath = projectFilePath.replace('.rivet-project', '.rivet-data');

  const datasetsFileExists = await nativeExists(datasetsFilePath);

  // No data file, so just no datasets
  if (!datasetsFileExists) {
    return { datasets: [], evaluationDatasets: [] };
  }

  const fileContents = await nativeReadTextFile(datasetsFilePath);

  return parseDatasetsFileContents(fileContents, project);
}

/** Shared sidecar parsing for standalone files and manifest-declared bundle data. */
export function parseDatasetsFileContents(fileContents: string, project: Project) {
  const datasets = deserializeDatasets(fileContents);
  const parsed = JSON.parse(fileContents) as { evaluationDatasets?: unknown };
  const evaluationDatasets = Array.isArray(parsed.evaluationDatasets)
    ? (parsed.evaluationDatasets as EvaluationDataset[])
    : [];
  return {
    datasets,
    evaluationDatasets: evaluationDatasets.flatMap((dataset) => {
      try {
        const validated = validateEvaluationDataset(dataset);
        return validated.projectId === undefined || validated.projectId === project.metadata.id ? [validated] : [];
      } catch {
        // Evaluation datasets are a legacy migration input. Ignore an invalid
        // entry rather than preventing the unrelated project data from loading.
        return [];
      }
    }),
  };
}
