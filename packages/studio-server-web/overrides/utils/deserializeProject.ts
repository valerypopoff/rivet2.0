import type { CombinedDataset, Project } from '@valerypopoff/rivet2-core';
import type { EvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import type { EvaluationProjectFileData } from '../../../app/src/io/IOProvider.js';
import { createWorkerRequests, type WorkerRequestOptions } from '../../../app/src/utils/workerRequests.js';

type DeserializedHostedProjectPayload = {
  project: Project;
  serializedEvaluationData: EvaluationProjectData | null;
  datasets: CombinedDataset[];
  evaluationDatasets: EvaluationProjectFileData['evaluationDatasets'];
};

const request = createWorkerRequests(
  () => new Worker(new URL('./deserializeProject.worker.ts', import.meta.url), { type: 'module' }),
);

export function deserializeProjectAsync(
  serializedProject: unknown,
  path?: string,
  options?: WorkerRequestOptions,
): Promise<Project> {
  return request('deserializeProject', { serializedProject, path }, options);
}

export function deserializeHostedProjectPayloadAsync(
  serializedProject: unknown,
  path?: string,
  options?: WorkerRequestOptions & { datasetsContents?: string | null },
): Promise<DeserializedHostedProjectPayload> {
  return request(
    'deserializeHostedProjectPayload',
    { serializedProject, path, datasetsContents: options?.datasetsContents },
    options,
  );
}
