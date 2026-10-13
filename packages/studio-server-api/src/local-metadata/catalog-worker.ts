import { parentPort, workerData } from 'node:worker_threads';
import { deserialize } from 'node:v8';
import { LocalWorkflowCatalog } from './workflow-catalog.js';
import { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';

const catalog = new LocalWorkflowCatalog(workerData.options);
const cache = new ManagedWorkflowExecutionCache();
const allowed = new Set(
  Object.getOwnPropertyNames(LocalWorkflowCatalog.prototype).filter(
    (name) => name !== 'constructor' && name !== 'mutatePublication' && !name.startsWith('#'),
  ),
);
parentPort!.on('message', async ({ id, method, args: encoded }: { id: number; method: string; args: Uint8Array }) => {
  try {
    const args = deserialize(encoded) as unknown[];
    if (!allowed.has(method)) throw new Error('Unsupported local catalog operation.');
    const value =
      method === 'readExecutionSource'
        ? await catalog.readExecutionSource(
            args[0] as Parameters<LocalWorkflowCatalog['readExecutionSource']>[0],
            args[1] ? cache : undefined,
          )
        : await (catalog as unknown as Record<string, (...args: unknown[]) => unknown>)[method]!.apply(catalog, args);
    parentPort!.postMessage({ id, value });
  } catch (error) {
    const actual = error instanceof Error ? error : new Error(String(error));
    parentPort!.postMessage({ id, error: { message: actual.message, name: actual.name, properties: { ...actual } } });
  }
});
