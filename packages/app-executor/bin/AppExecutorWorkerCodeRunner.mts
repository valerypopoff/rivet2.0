import {
  resolveCodeInterpolationExpression,
  type CodeConsoleLevel,
  type CodeConsoleMessage,
  type CodeRunner,
  type CodeRunnerOptions,
  type DataValue,
  type Inputs,
  type Outputs,
} from '@valerypopoff/rivet2-core';
import { createScopedNodeProcess, type NodeExecutionEnvironment } from '@valerypopoff/rivet2-node';
import { inspect } from 'node:util';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { resolveCodeRunnerRequireAnchor } from './codeRunnerRequire.mjs';
import { getSharedCodeWorkerPool, type AppExecutorCodeWorkerPool } from './codeRunnerWorkerPool.mjs';
import { createCodeWorkerRunRequest } from './codeRunnerWorkerHost.mjs';

export {
  AppExecutorCodeWorkerPool,
  prewarmSharedAppExecutorCodeWorkerPool,
  shutdownSharedAppExecutorCodeWorkerPool,
} from './codeRunnerWorkerPool.mjs';
export type { AppExecutorCodeWorkerPoolStats } from './codeRunnerWorkerPool.mjs';

export class AppExecutorWorkerCodeRunner implements CodeRunner {
  private binding: Promise<{ anchor: string; require: NodeJS.Require }> | undefined;

  constructor(
    private readonly onConsole?: (message: CodeConsoleMessage) => void,
    private readonly options: {
      executionEnvironment?: NodeExecutionEnvironment;
      workerPool?: AppExecutorCodeWorkerPool;
    } = {},
  ) {}

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
    globalValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    let binding: { anchor: string; require: NodeJS.Require } | undefined;
    if (options.includeRequire || options.includeRivet) {
      this.binding ??= prepareRuntimeLibrariesForCodeRunner().catch((error) => {
        this.binding = undefined;
        throw error;
      });
      binding = await this.binding;
    }

    if (options.includeRivet) {
      // The app sidecar isolates ordinary Code-family JavaScript in workers, but
      // Rivet-capable code imports @valerypopoff/rivet2-node. Keep that path on the
      // current thread so packaged sidecar module resolution stays compatible.
      return runCodeInCurrentThread(
        code,
        inputs,
        options,
        graphInputs,
        contextValues,
        globalValues,
        binding!.require,
        this.onConsole,
        this.options.executionEnvironment,
      );
    }

    return runCodeInWorker(
      code,
      inputs,
      options,
      graphInputs,
      contextValues,
      globalValues,
      this.onConsole,
      this.options.workerPool ?? getSharedCodeWorkerPool(),
      this.options.executionEnvironment,
      binding?.anchor,
    );
  }
}

async function prepareRuntimeLibrariesForCodeRunner() {
  const prepare = (
    globalThis as typeof globalThis & {
      __RIVET_PREPARE_RUNTIME_LIBRARIES__?: (force?: boolean) => Promise<unknown> | unknown;
    }
  ).__RIVET_PREPARE_RUNTIME_LIBRARIES__;

  const snapshot = typeof prepare === 'function' ? await prepare(true) : null;
  let anchor: string;
  if (snapshot === null && !process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim()) anchor = resolveCodeRunnerRequireAnchor();
  else if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'version' in snapshot &&
    snapshot.version === 1 &&
    'requireAnchorPath' in snapshot &&
    typeof snapshot.requireAnchorPath === 'string' &&
    isAbsolute(snapshot.requireAnchorPath)
  )
    anchor = snapshot.requireAnchorPath;
  else throw new Error('Runtime-library preparation did not return a verified snapshot.');
  return { anchor, require: createRequire(anchor) };
}

async function runCodeInWorker(
  code: string,
  inputs: Inputs,
  options: CodeRunnerOptions,
  graphInputs: Record<string, DataValue> | undefined,
  contextValues: Record<string, DataValue> | undefined,
  globalValues: Record<string, DataValue> | undefined,
  onConsole?: (message: CodeConsoleMessage) => void,
  workerPool = getSharedCodeWorkerPool(),
  executionEnvironment?: NodeExecutionEnvironment,
  requireAnchorPath?: string,
): Promise<Outputs> {
  return workerPool.run(
    createCodeWorkerRunRequest(
      code,
      inputs,
      options,
      graphInputs,
      contextValues,
      globalValues,
      executionEnvironment,
      requireAnchorPath,
    ),
    onConsole,
  );
}

async function runCodeInCurrentThread(
  code: string,
  inputs: Inputs,
  options: CodeRunnerOptions,
  graphInputs: Record<string, DataValue> | undefined,
  contextValues: Record<string, DataValue> | undefined,
  globalValues: Record<string, DataValue> | undefined,
  runtimeRequire: NodeJS.Require,
  onConsole?: (message: CodeConsoleMessage) => void,
  executionEnvironment?: NodeExecutionEnvironment,
): Promise<Outputs> {
  const argNames = ['inputs'];
  const args: unknown[] = [inputs];

  if (options.includeConsole) {
    argNames.push('console');
    args.push(createBridgedConsole(onConsole));
  }

  if (options.includeRequire) {
    argNames.push('require');
    args.push(runtimeRequire);
  }

  if (options.includeProcess) {
    argNames.push('process');
    args.push(createScopedNodeProcess(executionEnvironment));
  }

  if (options.includeFetch) {
    argNames.push('fetch');
    args.push(fetch);
  }

  if (options.includeRivet) {
    const Rivet = await import('@valerypopoff/rivet2-node');

    argNames.push('Rivet');
    args.push(Rivet);
  }

  if (graphInputs) {
    argNames.push('graphInputs');
    args.push(graphInputs);
  }

  if (contextValues) {
    argNames.push('context');
    args.push(contextValues);
  }

  if (options.interpolationHelperIdentifier) {
    argNames.push(options.interpolationHelperIdentifier);
    args.push(resolveCodeInterpolationExpression);
  }

  if (options.globalValuesIdentifier) {
    argNames.push(options.globalValuesIdentifier);
    args.push(globalValues ?? Object.create(null));
  }

  argNames.push(code);

  const AsyncFunction = async function () {}.constructor as new (...args: string[]) => Function;
  const codeFunction = new AsyncFunction(...argNames);
  return (await codeFunction(...args)) as Outputs;
}

const CONSOLE_LEVELS: CodeConsoleLevel[] = ['debug', 'error', 'info', 'log', 'warn'];

function createBridgedConsole(onConsole?: (message: CodeConsoleMessage) => void) {
  const bridgedConsole = Object.create(console) as Pick<Console, CodeConsoleLevel>;

  for (const level of CONSOLE_LEVELS) {
    bridgedConsole[level] = (...args: unknown[]) => {
      emitConsoleMessage(onConsole, {
        level,
        args: args.map(serializeConsoleArg),
      });
    };
  }

  return bridgedConsole;
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

function serializeConsoleArg(arg: unknown): unknown {
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
