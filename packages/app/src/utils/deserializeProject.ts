import type { Project } from '@valerypopoff/rivet2-core';
import { createWorkerRequests, type WorkerRequestOptions } from './workerRequests.js';

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
