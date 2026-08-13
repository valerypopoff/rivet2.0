import type { CodeConsoleMessage, CodeRunnerOptions, DataValue, Inputs, Outputs } from '@valerypopoff/rivet2-core';
import { Worker } from 'node:worker_threads';
import { getCodeRunnerRequireAnchorPath } from './codeRunnerRequire.mjs';

type SerializedWorkerError = {
  message: string;
  name?: string;
  stack?: string;
};

type WorkerResponse =
  | {
      type: 'ready';
    }
  | {
      type: 'result';
      ok: true;
      outputs: Outputs;
    }
  | {
      type: 'result';
      error: SerializedWorkerError;
      ok: false;
    }
  | {
      type: 'console';
      message: CodeConsoleMessage;
    };

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { inspect } = require('node:util');

const CONSOLE_LEVELS = ['debug', 'error', 'info', 'log', 'warn'];

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function serializeConsoleArg(arg) {
  if (typeof arg === 'string') {
    return arg;
  }

  return inspect(arg, {
    breakLength: 120,
    depth: 6,
    maxArrayLength: 100,
    maxStringLength: 10000,
  });
}

function createBridgedConsole() {
  const bridgedConsole = Object.create(console);

  for (const level of CONSOLE_LEVELS) {
    bridgedConsole[level] = (...args) => {
      parentPort.postMessage({
        type: 'console',
        message: {
          level,
          args: args.map(serializeConsoleArg),
        },
      });
    };
  }

  return bridgedConsole;
}

async function runCode(request) {
  const { code, contextValues, executionEnvironment, graphInputs, inputs, options, requireAnchorPath } = request;
  const argNames = ['inputs'];
  const args = [inputs];

  if (options.includeConsole) {
    argNames.push('console');
    args.push(createBridgedConsole());
  }

  if (options.includeRequire) {
    argNames.push('require');
    args.push(createRequire(requireAnchorPath));
  }

  if (options.includeProcess) {
    argNames.push('process');
    args.push(createScopedProcess(executionEnvironment));
  }

  if (options.includeFetch) {
    argNames.push('fetch');
    args.push(fetch);
  }

  if (graphInputs) {
    argNames.push('graphInputs');
    args.push(graphInputs);
  }

  if (contextValues) {
    argNames.push('context');
    args.push(contextValues);
  }

  argNames.push(code);

  const AsyncFunction = async function () {}.constructor;
  const codeFunction = new AsyncFunction(...argNames);
  return await codeFunction(...args);
}

function createScopedProcess(executionEnvironment) {
  if (!executionEnvironment || Object.keys(executionEnvironment).length === 0) {
    return process;
  }

  const environment = { ...process.env };
  for (const [name, value] of Object.entries(executionEnvironment)) {
    if (value === undefined) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }

  Object.freeze(environment);
  return new Proxy(process, {
    get(target, property) {
      return property === 'env' ? environment : Reflect.get(target, property, target);
    },
    set(target, property, value) {
      if (property === 'env') {
        return false;
      }
      return Reflect.set(target, property, value, target);
    },
    defineProperty(target, property, descriptor) {
      if (property === 'env') {
        return false;
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (property === 'env') {
        return false;
      }
      return Reflect.deleteProperty(target, property);
    },
  });
}

parentPort.postMessage({ type: 'ready' });

parentPort.once('message', (request) => {
  if (!request || request.type !== 'run') {
    parentPort.postMessage({
      type: 'result',
      ok: false,
      error: serializeError(new Error('Code worker received an invalid run request.')),
    });
    return;
  }

  runCode(request).then(
    (outputs) => {
      try {
        parentPort.postMessage({ type: 'result', ok: true, outputs });
      } catch (error) {
        parentPort.postMessage({ type: 'result', ok: false, error: serializeError(error) });
      }
    },
    (error) => parentPort.postMessage({ type: 'result', ok: false, error: serializeError(error) }),
  );
});
`;

export type CodeWorkerRunRequest = {
  code: string;
  contextValues: Record<string, DataValue> | undefined;
  executionEnvironment: Readonly<Record<string, string | undefined>> | undefined;
  graphInputs: Record<string, DataValue> | undefined;
  inputs: Inputs;
  options: CodeRunnerOptions;
  requireAnchorPath: string;
  type: 'run';
};

export function createCodeWorkerRunRequest(
  code: string,
  inputs: Inputs,
  options: CodeRunnerOptions,
  graphInputs: Record<string, DataValue> | undefined,
  contextValues: Record<string, DataValue> | undefined,
  executionEnvironment?: Readonly<Record<string, string | undefined>>,
): CodeWorkerRunRequest {
  return {
    code,
    contextValues,
    executionEnvironment,
    graphInputs,
    inputs,
    options,
    requireAnchorPath: getCodeRunnerRequireAnchorPath(),
    type: 'run',
  };
}

export function createReadyCodeWorker(): Promise<Worker> {
  const worker = new Worker(WORKER_SOURCE, { eval: true });

  return new Promise<Worker>((resolve, reject) => {
    let ready = false;

    const cleanup = () => {
      worker.off('message', handleMessage);
      worker.off('error', handleError);
      worker.off('exit', handleExit);
    };

    const fail = (error: Error) => {
      cleanup();
      void worker.terminate();
      reject(error);
    };

    const handleMessage = (response: WorkerResponse) => {
      if (response.type !== 'ready') {
        return;
      }

      ready = true;
      cleanup();
      resolve(worker);
    };

    const handleError = (error: Error) => {
      fail(error);
    };

    const handleExit = (code: number) => {
      if (!ready) {
        fail(
          new Error(
            code === 0
              ? 'Code worker exited before becoming ready.'
              : `Code worker exited before becoming ready with exit code ${code}.`,
          ),
        );
      }
    };

    worker.on('message', handleMessage);
    worker.once('error', handleError);
    worker.once('exit', handleExit);
  });
}

export async function runCodeOnReadyWorker(
  worker: Worker,
  request: CodeWorkerRunRequest,
  onConsole?: (message: CodeConsoleMessage) => void,
): Promise<Outputs> {
  worker.ref();

  return await new Promise<Outputs>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      worker.off('message', handleMessage);
      worker.off('error', handleError);
      worker.off('exit', handleExit);
      void worker.terminate();
    };

    const handleMessage = (response: WorkerResponse) => {
      if (response.type === 'console') {
        emitConsoleMessage(onConsole, response.message);
        return;
      }
      if (response.type !== 'result') {
        return;
      }

      settled = true;
      cleanup();

      if (response.ok) {
        resolve(response.outputs);
      } else {
        reject(deserializeWorkerError(response.error));
      }
    };

    const handleError = (error: Error) => {
      settled = true;
      cleanup();
      reject(error);
    };

    const handleExit = (code: number) => {
      if (!settled) {
        cleanup();
        reject(
          new Error(
            code === 0
              ? 'Code worker exited before returning outputs.'
              : `Code worker exited before returning outputs with exit code ${code}.`,
          ),
        );
      }
    };

    worker.on('message', handleMessage);
    worker.once('error', handleError);
    worker.once('exit', handleExit);

    try {
      worker.postMessage(request);
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

function emitConsoleMessage(
  onConsole: ((message: CodeConsoleMessage) => void) | undefined,
  message: CodeConsoleMessage,
) {
  try {
    onConsole?.(message);
  } catch {
    // Console forwarding is observability-only and must not change Code-family execution.
  }
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
  const ErrorCtor = getErrorConstructor(error.name);
  const deserialized = new ErrorCtor(error.message);
  if (error.name) {
    deserialized.name = error.name;
  }
  if (error.stack) {
    deserialized.stack = error.stack;
  }

  return deserialized;
}

function getErrorConstructor(name?: string): ErrorConstructor {
  switch (name) {
    case 'EvalError':
      return EvalError;
    case 'RangeError':
      return RangeError;
    case 'ReferenceError':
      return ReferenceError;
    case 'SyntaxError':
      return SyntaxError;
    case 'TypeError':
      return TypeError;
    case 'URIError':
      return URIError;
    default:
      return Error;
  }
}
