import type { Inputs, Outputs } from '../index.js';
import type { DataValue } from '../model/DataValue.js';

// eslint-disable-next-line import/no-cycle -- There has to be a cycle if we're to import the entirety of Rivet here.
import * as Rivet from '../exports.js';

export interface CodeRunnerOptions {
  includeRequire: boolean;
  includeFetch: boolean;
  includeRivet: boolean;
  includeProcess: boolean;
  includeConsole: boolean;
}

/**
 * Code and Expression nodes request every API their executor can provide.
 *
 * This is intentionally not a permission system or a sandbox. Node runners
 * provide the Node-specific APIs, while browser runners only supply the APIs
 * they actually implement.
 */
export const ALL_CODE_RUNNER_OPTIONS: CodeRunnerOptions = Object.freeze({
  includeRequire: true,
  includeFetch: true,
  includeRivet: true,
  includeProcess: true,
  includeConsole: true,
});

/** An object that can run arbitrary code (evals it). */
export interface CodeRunner {
  runCode: (
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
  ) => Promise<Outputs>;
}

export class IsomorphicCodeRunner implements CodeRunner {
  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    const argNames = ['inputs'];
    const args: any[] = [inputs];

    if (options.includeConsole) {
      argNames.push('console');
      args.push(console);
    }

    if (options.includeFetch) {
      argNames.push('fetch');
      args.push(fetch);
    }

    if (options.includeRivet) {
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

    argNames.push(code);

    const AsyncFunction = async function () {}.constructor as new (...args: string[]) => Function;
    const codeFunction = new AsyncFunction(...argNames);
    const outputs = await codeFunction(...args);

    return outputs;
  }
}

export class NotAllowedCodeRunner implements CodeRunner {
  async runCode(
    _code: string,
    _inputs: Inputs,
    _options: CodeRunnerOptions,
    _graphInputs?: Record<string, DataValue>,
    _contextValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    throw new Error('Dynamic code execution is disabled.');
  }
}
