import { getError, type Project } from '@valerypopoff/rivet2-core';
import type { EvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import { nanoid } from 'nanoid';

type PromiseResolvers<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  responseType: string;
};

type DeserializedHostedProjectPayload = {
  project: Project;
  serializedEvaluationData: EvaluationProjectData | null;
};

const waiting = new Map<string, PromiseResolvers<unknown>>();
let worker = createWorker();

function rejectAllPendingRequests(error: unknown): void {
  const normalizedError = getError(error);

  for (const request of waiting.values()) {
    request.reject(normalizedError);
  }

  waiting.clear();
}

function restartWorker(failedWorker: Worker, error: unknown): void {
  if (worker !== failedWorker) {
    return;
  }

  console.error('Restarting project deserialize worker after fatal error');
  rejectAllPendingRequests(error);

  try {
    failedWorker.terminate();
  } catch {
    // Ignore terminate failures during recovery.
  }

  worker = createWorker();
}

function createWorker(): Worker {
  const nextWorker = new Worker(new URL('./deserializeProject.worker.ts', import.meta.url), { type: 'module' });

  nextWorker.addEventListener('error', (event) => {
    console.error('Worker error:', event);
    restartWorker(nextWorker, new Error(event.message || 'Project deserialize worker failed'));
  });

  nextWorker.addEventListener('messageerror', (event) => {
    console.error('Worker message error:', event);
    restartWorker(nextWorker, new Error('Project deserialize worker returned an unreadable message'));
  });

  nextWorker.addEventListener('message', (event) => {
    const { id, type, result, error } = event.data;
    const request = waiting.get(id);

    if (!request || request.responseType !== type) {
      console.error('No resolvers found for id:', id);
      return;
    }

    waiting.delete(id);

    if (error) {
      request.reject(getError(error));
      return;
    }

    request.resolve(result);
  });

  return nextWorker;
}

function enqueueWorkerRequest<T>(
  type: 'deserializeProject' | 'deserializeHostedProjectPayload',
  data: unknown,
  responseType: string,
): Promise<T> {
  const id = nanoid();

  const resolvers: PromiseResolvers<T> = { resolve: undefined!, reject: undefined!, responseType };
  const promise = new Promise<T>((res, rej) => {
    resolvers.resolve = res;
    resolvers.reject = rej;
  });

  waiting.set(id, resolvers as PromiseResolvers<unknown>);
  worker.postMessage({ id, type, data });
  return promise;
}

export function deserializeProjectAsync(serializedProject: unknown, path?: string): Promise<Project> {
  return enqueueWorkerRequest<Project>(
    'deserializeProject',
    { serializedProject, path },
    'deserializeProject:result',
  );
}

export function deserializeHostedProjectPayloadAsync(
  serializedProject: unknown,
  path?: string,
): Promise<DeserializedHostedProjectPayload> {
  return enqueueWorkerRequest<DeserializedHostedProjectPayload>(
    'deserializeHostedProjectPayload',
    { serializedProject, path },
    'deserializeHostedProjectPayload:result',
  );
}
