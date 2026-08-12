import type { CodeRunnerOptions, DataValue, Inputs, Outputs } from '@valerypopoff/rivet2-core';
import * as process from 'node:process';
import type { createCodeRunnerRequire } from './codeRunnerRequire.js';

type RuntimeRequire = ReturnType<typeof createCodeRunnerRequire>;
export type NodeCodeRunnerFunction = (...args: unknown[]) => Promise<Outputs>;
export type NodeExecutionEnvironment = Readonly<Record<string, string | undefined>>;

export type NodeCodeRunnerInvocation = {
  argNames: string[];
  args: unknown[];
};

export type NodeCodeRunnerInvocationPlan = {
  argNames: string[];
  argShape: string;
};

/**
 * Gives one processor an immutable environment view without mutating the Node
 * process global. Hosted runtimes use this for UI-managed execution variables,
 * so concurrent runs cannot observe each other's overrides.
 */
export function createScopedNodeProcess(executionEnvironment?: NodeExecutionEnvironment): NodeJS.Process {
  if (!executionEnvironment || Object.keys(executionEnvironment).length === 0) {
    return process;
  }

  const environment = { ...process.env } as Record<string, string | undefined>;
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

const ARGUMENT_SHAPE_SEPARATOR = '\0';

export function getNodeCodeRunnerArgumentNames(
  options: CodeRunnerOptions,
  hasGraphInputs: boolean,
  hasContextValues: boolean,
): string[] {
  const argNames = ['inputs'];

  if (options.includeConsole) {
    argNames.push('console');
  }

  if (options.includeRequire) {
    argNames.push('require');
  }

  if (options.includeProcess) {
    argNames.push('process');
  }

  if (options.includeFetch) {
    argNames.push('fetch');
  }

  if (options.includeRivet) {
    argNames.push('Rivet');
  }

  if (hasGraphInputs) {
    argNames.push('graphInputs');
  }

  if (hasContextValues) {
    argNames.push('context');
  }

  return argNames;
}

export function createNodeCodeRunnerInvocationPlan(
  options: CodeRunnerOptions,
  hasGraphInputs: boolean,
  hasContextValues: boolean,
): NodeCodeRunnerInvocationPlan {
  const argNames = getNodeCodeRunnerArgumentNames(options, hasGraphInputs, hasContextValues);

  return {
    argNames,
    argShape: argNames.join(ARGUMENT_SHAPE_SEPARATOR),
  };
}

export async function buildNodeCodeRunnerInvocationArgs(params: {
  contextValues?: Record<string, DataValue>;
  executionEnvironment?: NodeExecutionEnvironment;
  graphInputs?: Record<string, DataValue>;
  inputs: Inputs;
  loadRivet: () => Promise<unknown>;
  options: CodeRunnerOptions;
  runtimeRequire: RuntimeRequire;
}): Promise<unknown[]> {
  const { contextValues, executionEnvironment, graphInputs, inputs, loadRivet, options, runtimeRequire } = params;
  const args: unknown[] = [inputs];

  if (options.includeConsole) {
    args.push(console);
  }

  if (options.includeRequire) {
    args.push(runtimeRequire);
  }

  if (options.includeProcess) {
    args.push(createScopedNodeProcess(executionEnvironment));
  }

  if (options.includeFetch) {
    args.push(fetch);
  }

  if (options.includeRivet) {
    args.push(await loadRivet());
  }

  if (graphInputs) {
    args.push(graphInputs);
  }

  if (contextValues) {
    args.push(contextValues);
  }

  return args;
}

export async function buildNodeCodeRunnerInvocation(params: {
  contextValues?: Record<string, DataValue>;
  executionEnvironment?: NodeExecutionEnvironment;
  graphInputs?: Record<string, DataValue>;
  inputs: Inputs;
  loadRivet: () => Promise<unknown>;
  options: CodeRunnerOptions;
  runtimeRequire: RuntimeRequire;
}): Promise<NodeCodeRunnerInvocation> {
  const { contextValues, executionEnvironment, graphInputs, inputs, loadRivet, options, runtimeRequire } = params;
  const { argNames } = createNodeCodeRunnerInvocationPlan(options, graphInputs != null, contextValues != null);
  const args = await buildNodeCodeRunnerInvocationArgs({
    contextValues,
    executionEnvironment,
    graphInputs,
    inputs,
    loadRivet,
    options,
    runtimeRequire,
  });

  return {
    argNames,
    args,
  };
}

export function compileNodeCodeRunnerFunction(argNames: string[], code: string): NodeCodeRunnerFunction {
  const AsyncFunction = async function () {}.constructor as new (...args: string[]) => NodeCodeRunnerFunction;
  return new AsyncFunction(...argNames, code);
}
