import { deserializeProject, type CombinedDataset } from '@valerypopoff/rivet2-core/serialization';
import type { EvaluationProjectFileData } from '../../../app/src/io/IOProvider.js';

/** Worker-owned preparation: parse each large sidecar once, away from the UI. */
export function parseHostedProjectPayload(serializedProject: unknown, path?: string, datasetsContents?: string | null) {
  const [project, attachedData] = deserializeProject(serializedProject, path);
  let datasets: CombinedDataset[] = [];
  let evaluationDatasets: EvaluationProjectFileData['evaluationDatasets'] = [];
  if (datasetsContents) {
    const sidecar = JSON.parse(datasetsContents) as {
      datasets?: CombinedDataset[];
      evaluationDatasets?: EvaluationProjectFileData['evaluationDatasets'];
    } | null;
    if (
      !sidecar ||
      !Array.isArray(sidecar.datasets) ||
      (sidecar.evaluationDatasets != null && !Array.isArray(sidecar.evaluationDatasets))
    )
      throw new Error('Invalid dataset data');
    datasets = sidecar.datasets;
    evaluationDatasets = sidecar.evaluationDatasets ?? [];
  }
  return { project, serializedEvaluationData: attachedData.evaluations ?? null, datasets, evaluationDatasets };
}
