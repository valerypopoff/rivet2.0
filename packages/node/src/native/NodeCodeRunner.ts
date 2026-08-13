import type { CodeRunner, CodeRunnerOptions, DataValue, Inputs, Outputs } from '@valerypopoff/rivet2-core';
import { createCodeRunnerRequire } from './codeRunnerRequire.js';
import {
  buildNodeCodeRunnerInvocation,
  compileNodeCodeRunnerFunction,
  type NodeExecutionEnvironment,
} from './nodeCodeRunnerInvocation.js';

export class NodeCodeRunner implements CodeRunner {
  private readonly runtimeRequire = createCodeRunnerRequire();

  constructor(private readonly executionEnvironment?: NodeExecutionEnvironment) {}

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    const { argNames, args } = await buildNodeCodeRunnerInvocation({
      contextValues,
      executionEnvironment: this.executionEnvironment,
      graphInputs,
      inputs,
      loadRivet: () => import('@valerypopoff/rivet2-node'),
      options,
      runtimeRequire: this.runtimeRequire,
    });
    const codeFunction = compileNodeCodeRunnerFunction(argNames, code);
    const outputs = await codeFunction(...args);

    return outputs;
  }
}
