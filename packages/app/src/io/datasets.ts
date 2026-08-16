import { type Project, deserializeDatasets, serializeDatasets } from '@valerypopoff/rivet2-core';
import { validateEvaluationDataset, type EvaluationDataset } from '@valerypopoff/rivet2-evaluations';
import { allowDataFileNeighbor } from '../utils/tauri.js';
import { type AppDatasetProvider, type PathPolicyProvider } from '../providers/ProvidersContext.js';
import { nativeExists, nativeReadTextFile, nativeWriteFile } from '../utils/platform/fs.js';

export async function saveDatasetsFile(
  projectFilePath: string,
  project: Project,
  datasetProvider: AppDatasetProvider,
  evaluationDatasets: readonly EvaluationDataset[] = [],
  pathPolicy?: PathPolicyProvider,
) {
  await (pathPolicy?.allowDataFileNeighbor ?? allowDataFileNeighbor)(projectFilePath);

  const dataPath = projectFilePath.replace('.rivet-project', '.rivet-data');
  const datasets = await datasetProvider.exportDatasetsForProject(project.metadata.id);

  if (datasets.length > 0 || evaluationDatasets.length > 0 || (await nativeExists(dataPath))) {
    const serializedDatasets = JSON.parse(serializeDatasets(datasets)) as { datasets: unknown };
    const normalizedEvaluations = evaluationDatasets.map((dataset) => validateEvaluationDataset(dataset));

    await nativeWriteFile({
      contents: JSON.stringify({ ...serializedDatasets, evaluationDatasets: normalizedEvaluations }),
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
  await (pathPolicy?.allowDataFileNeighbor ?? allowDataFileNeighbor)(projectFilePath);

  const datasetsFilePath = projectFilePath.replace('.rivet-project', '.rivet-data');

  const datasetsFileExists = await nativeExists(datasetsFilePath);

  // No data file, so just no datasets
  if (!datasetsFileExists) {
    await datasetProvider.importDatasetsForProject?.(project.metadata.id, []);
    return [];
  }

  const fileContents = await nativeReadTextFile(datasetsFilePath);

  const datasets = deserializeDatasets(fileContents);
  const parsed = JSON.parse(fileContents) as { evaluationDatasets?: unknown };
  const evaluationDatasets = Array.isArray(parsed.evaluationDatasets)
    ? (parsed.evaluationDatasets as EvaluationDataset[])
    : [];
  await datasetProvider.importDatasetsForProject?.(project.metadata.id, datasets);
  return evaluationDatasets
    .map((dataset) => validateEvaluationDataset(dataset))
    .filter((dataset) => dataset.projectId === project.metadata.id);
}
