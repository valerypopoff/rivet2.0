import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CodeNodeImpl,
  IsomorphicCodeRunner,
  NotAllowedCodeRunner,
  type CodeNode,
  type CodeRunner,
  type CodeRunnerOptions,
  type Inputs,
  type InternalProcessContext,
  type NodeBodySpec,
  type Outputs,
  type ProcessId,
} from '../../../src/index.js';

const createNode = (data: Partial<CodeNode['data']>) => {
  return new CodeNodeImpl({
    ...CodeNodeImpl.create(),
    data: {
      ...CodeNodeImpl.create().data,
      ...data,
    },
  });
};

const createContext = (codeRunner = new IsomorphicCodeRunner()) =>
  ({
    codeRunner,
    contextValues: {},
    graphInputNodeValues: {},
    processId: 'test-process' as ProcessId,
  }) as InternalProcessContext;

class CapturingCodeRunner implements CodeRunner {
  options: CodeRunnerOptions | undefined;

  async runCode(_code: string, _inputs: Inputs, options: CodeRunnerOptions): Promise<Outputs> {
    this.options = options;
    return {
      output1: {
        type: 'any',
        value: 'captured',
      },
    };
  }
}

describe('CodeNode', () => {
  it('creates the legacy Code node label', () => {
    const node = CodeNodeImpl.create();

    assert.strictEqual(node.type, 'code');
    assert.strictEqual(node.title, 'Code (legacy)');
  });

  it('always requests every runtime API, ignoring retired saved permission fields', async () => {
    const codeRunner = new CapturingCodeRunner();
    const node = createNode({ code: 'return { output1: { type: "any", value: 1 } };' });
    (node.chartNode.data as Record<string, unknown>).allowRequire = false;

    await node.process({}, createContext(codeRunner));

    assert.deepStrictEqual(codeRunner.options, {
      includeConsole: true,
      includeFetch: true,
      includeProcess: true,
      includeRequire: true,
      includeRivet: true,
    });
  });

  it('returns a colorized body preview without per-line ellipsis truncation', () => {
    const node = createNode({
      code: [
        'const longLine = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";',
        'return { output1: { type: "string", value: longLine } };',
      ].join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      text: [
        'const longLine = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";',
        'return { output1: { type: "string", value: longLine } };',
      ].join('\n'),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    } satisfies NodeBodySpec);
  });

  it('still limits the preview to the first 15 lines', () => {
    const node = createNode({
      code: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      text: Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n'),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    } satisfies NodeBodySpec);
  });

  it('adds code-node line information to runtime errors', async () => {
    const node = createNode({
      code: [
        'const first = 1;',
        'const second = 2;',
        'const value = missingVariable;',
        'return { output1: { type: "number", value } };',
      ].join('\n'),
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof ReferenceError);
        assert.equal(error.name, 'ReferenceError');
        assert.match(error.message, /missingVariable is not defined/);
        assert.match(error.message, /Code \(legacy\) node line 3, column \d+/);
        assert.match(
          error.stack ?? '',
          /^ReferenceError: missingVariable is not defined \(Code \(legacy\) node line 3, column \d+\)/,
        );
        return true;
      },
    );
  });

  it('maps nested runtime stack frames back to code-node lines', async () => {
    const node = createNode({
      code: [
        'function getValue() {',
        '  return missingVariable;',
        '}',
        'getValue();',
        'return { output1: { type: "number", value: 1 } };',
      ].join('\n'),
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Code \(legacy\) node line 2, column \d+/);
        return true;
      },
    );
  });

  it('adds code-node line information to syntax errors after the run fails', async () => {
    const node = createNode({
      code: ['const first = 1;', 'if (first {', '  return { output1: { type: "number", value: first } };', '}'].join(
        '\n',
      ),
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'SyntaxError');
        assert.match(error.message, /Code \(legacy\) node line 2, column \d+/);
        return true;
      },
    );
  });

  it('does not add code line diagnostics to non-user-code errors', async () => {
    const node = createNode({
      code: 'return { output1: { type: "number", value: 1 } };',
    });

    await assert.rejects(
      () => node.process({}, createContext(new NotAllowedCodeRunner())),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Dynamic code execution is disabled.');
        return true;
      },
    );
  });

  it('guides users to explicit undefined outputs when a configured output is missing', async () => {
    const node = createNode({
      code: 'return {};',
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /return \{ "type": "control-flow-excluded", "value": undefined \}/);
        assert.match(error.message, /return \{ "type": "any", "value": undefined \}/);
        assert.doesNotMatch(error.message, /undefiend/);
        return true;
      },
    );
  });
});
