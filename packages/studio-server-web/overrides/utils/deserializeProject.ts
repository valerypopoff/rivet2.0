import { getError, type Project } from '@valerypopoff/rivet2-core';
import type { EvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import { nanoid } from 'nanoid';

type PromiseResolvers<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  responseType: string;
  cleanup: () => void;
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
    request.cleanup();
    request.reject(normalizedError);
  }

  waiting.clear();
}

function restartWorker(failedWorker: Worker, error: unknown, quiet = false): void {
  if (worker !== failedWorker) {
    return;
  }

  if (!quiet) console.error('Restarting project deserialize worker after fatal error');
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
      // Cancelled requests can still post a result before termination.
      return;
    }

    waiting.delete(id);
    request.cleanup();

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
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const id = nanoid();
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const currentWorker = worker;
  let timer: ReturnType<typeof setTimeout>;
  const abort = () => {
    waiting.delete(id);
    resolvers.cleanup();
    resolvers.reject(getError(options.signal?.reason ?? new DOMException('Project load cancelled', 'AbortError')));
    // A worker cannot interrupt synchronous parsing. Once no other request
    // owns it, terminate rather than make the next selection await that parse.
    if (waiting.size === 0) restartWorker(currentWorker, new Error('Project load cancelled'), true);
  };
  const resolvers: PromiseResolvers<T> = {
    resolve: undefined!,
    reject: undefined!,
    responseType,
    cleanup: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    },
  };
  const promise = new Promise<T>((res, rej) => {
    resolvers.resolve = res;
    resolvers.reject = rej;
  });

  waiting.set(id, resolvers as PromiseResolvers<unknown>);
  options.signal?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(
    () => restartWorker(currentWorker, new Error('Project parsing timed out. Please retry.')),
    options.timeoutMs ?? 60_000,
  );
  try {
    currentWorker.postMessage({ id, type, data });
  } catch (error) {
    waiting.delete(id);
    resolvers.cleanup();
    resolvers.reject(getError(error));
  }
  return promise;
}

export function deserializeProjectAsync(
  serializedProject: unknown,
  path?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Project> {
  return enqueueWorkerRequest<Project>(
    'deserializeProject',
    { serializedProject, path },
    'deserializeProject:result',
    options,
  );
}

export function deserializeHostedProjectPayloadAsync(
  serializedProject: unknown,
  path?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<DeserializedHostedProjectPayload> {
  return enqueueWorkerRequest<DeserializedHostedProjectPayload>(
    'deserializeHostedProjectPayload',
    { serializedProject, path },
    'deserializeHostedProjectPayload:result',
    options,
  );
}
