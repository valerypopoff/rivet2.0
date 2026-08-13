import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CodeNewNodeImpl,
  IsomorphicCodeRunner,
  NotAllowedCodeRunner,
  type CodeNewNode,
  type CodeRunner,
  type CodeRunnerOptions,
  type Inputs,
  type InternalProcessContext,
  type NodeBodySpec,
  type Outputs,
  type PortId,
  type ProcessId,
} from '../../../src/index.js';

const createNode = (data: Partial<CodeNewNode['data']>) => {
  return new CodeNewNodeImpl({
    ...CodeNewNodeImpl.create(),
    data: {
      ...CodeNewNodeImpl.create().data,
      ...data,
    },
  });
};

const createContext = (codeRunner = new IsomorphicCodeRunner(), overrides: Partial<InternalProcessContext> = {}) =>
  ({
    codeRunner,
    contextValues: {},
    graphInputNodeValues: {},
    processId: 'test-process' as ProcessId,
    ...overrides,
  }) as InternalProcessContext;

class CapturingCodeRunner implements CodeRunner {
  calls: {
    code: string;
    graphInputs?: InternalProcessContext['graphInputNodeValues'];
    contextValues?: InternalProcessContext['contextValues'];
    inputs: Inputs;
    options: CodeRunnerOptions;
  }[] = [];

  constructor(
    private readonly outputs: unknown = {
      output: {
        type: 'any',
        value: 'captured',
      },
    },
  ) {}

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: InternalProcessContext['graphInputNodeValues'],
    contextValues?: InternalProcessContext['contextValues'],
  ): Promise<Outputs> {
    this.calls.push({
      code,
      inputs,
      options,
      graphInputs,
      contextValues,
    });

    return this.outputs as Outputs;
  }
}

describe('CodeNewNode', () => {
  it('can create node', () => {
    const node = CodeNewNodeImpl.create();

    assert.strictEqual(node.type, 'codeNew');
    assert.strictEqual(node.title, 'Code');
    assert.match(node.data.code, /Interpolation tokens create input ports/);
    assert.match(node.data.code, /return value;/);
    assert.deepStrictEqual(
      new CodeNewNodeImpl(node).getInputDefinitions().map((input) => input.id),
      ['input'],
    );
  });

  it('creates one code editor and no manual input/output editors', () => {
    const editors = new CodeNewNodeImpl(CodeNewNodeImpl.create()).getEditors();

    assert.deepStrictEqual(editors, [
      {
        type: 'code',
        label: 'Code',
        helperMessage:
          'Use {{var}} to create input ports. Interpolated variables evaluate as the connected values. Node execution also provides "require" and "process". Browser execution provides "fetch", "console", and "Rivet".',
        dataKey: 'code',
        language: 'javascript',
        interpolationSyntax: 'js-value',
        enableFolding: true,
      },
    ]);
  });

  it('renders a colorized code preview body', () => {
    const node = createNode({
      code: [
        'const longLine = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";',
        'return longLine;',
      ].join('\n'),
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      text: [
        'const longLine = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";',
        'return longLine;',
      ].join('\n'),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    } satisfies NodeBodySpec);
  });

  it('creates interpolation-derived input ports and one fixed output', () => {
    const node = createNode({
      code: 'const value = {{a}} + {{b}};\nreturn value;',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => [definition.id, definition.dataType]),
      [
        ['a', 'any'],
        ['b', 'any'],
      ],
    );
    assert.deepStrictEqual(node.getOutputDefinitions(), [
      {
        id: 'output',
        title: 'Output',
        dataType: 'any',
      },
    ]);
  });

  it('evaluates a JavaScript body and returns the returned value', async () => {
    const node = createNode({
      code: 'const doubled = {{value}} * 2;\nreturn doubled;',
    });

    const result = await node.process(
      {
        ['value' as PortId]: { type: 'number', value: 21 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      output: {
        type: 'any',
        value: 42,
      },
    });
  });

  it('returns objects, null, and undefined as exact output values', async () => {
    const objectNode = createNode({
      code: 'return { foo: "bar" };',
    });
    const nullNode = createNode({
      code: 'return null;',
    });
    const undefinedNode = createNode({
      code: 'return undefined;',
    });

    assert.deepStrictEqual((await objectNode.process({}, createContext())).output?.value, { foo: 'bar' });
    assert.deepStrictEqual((await nullNode.process({}, createContext())).output?.value, null);
    assert.deepStrictEqual((await undefinedNode.process({}, createContext())).output?.value, undefined);
  });

  it('treats missing interpolation inputs as undefined', async () => {
    const node = createNode({
      code: 'return typeof {{missing}};',
    });

    const result = await node.process({}, createContext());

    assert.deepStrictEqual(result.output?.value, 'undefined');
  });

  it('keeps escaped interpolation tokens literal and does not create ports for them', async () => {
    const node = createNode({
      code: 'return "{{{a}}}";',
    });

    assert.deepStrictEqual(node.getInputDefinitions(), []);

    const result = await node.process({}, createContext());

    assert.deepStrictEqual(result.output?.value, '{{a}}');
  });

  it('does not mutate upstream object input values', async () => {
    const node = createNode({
      code: '{{object}}.nested.key = "changed";\nreturn {{object}};',
    });
    const object = { nested: { key: 'original' } };

    const result = await node.process(
      {
        ['object' as PortId]: { type: 'object', value: object },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, { nested: { key: 'changed' } });
    assert.deepStrictEqual(object, { nested: { key: 'original' } });
  });

  it('keeps interpolation values available when authored code uses generated helper names', async () => {
    const node = createNode({
      code: 'const __codeNewInputs = {};\nconst codeNewInputCloneCache = new WeakMap();\nreturn {{value}};',
    });

    const result = await node.process(
      {
        ['value' as PortId]: { type: 'number', value: 7 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 7);
  });

  it('always requests every runtime API, ignoring retired saved permission fields', async () => {
    const codeRunner = new CapturingCodeRunner();
    const node = createNode({ code: 'return 1;' });
    (node.chartNode.data as Record<string, unknown>).allowRivet = false;

    await node.process({}, createContext(codeRunner));

    assert.deepStrictEqual(codeRunner.calls[0]?.options, {
      includeConsole: true,
      includeFetch: true,
      includeProcess: true,
      includeRequire: true,
      includeRivet: true,
    });
  });

  it('can read current graph inputs and context values', async () => {
    const node = createNode({
      code: 'return graphInputs.graphValue.value + context.contextValue.value;',
    });

    const result = await node.process(
      {},
      createContext(new IsomorphicCodeRunner(), {
        graphInputNodeValues: {
          graphValue: { type: 'number', value: 2 },
        },
        contextValues: {
          contextValue: { type: 'number', value: 3 },
        },
      }),
    );

    assert.deepStrictEqual(result, {
      output: {
        type: 'any',
        value: 5,
      },
    });
  });

  it('respects disabled dynamic code execution', async () => {
    const node = createNode({
      code: 'return 1 + 1;',
    });

    await assert.rejects(
      () => node.process({}, createContext(new NotAllowedCodeRunner())),
      /Dynamic code execution is disabled\./,
    );
  });

  it('rejects invalid runner outputs before graph state can store them', async () => {
    const node = createNode({
      code: 'return "ignored by this test runner";',
    });

    await assert.rejects(
      () => node.process({}, createContext(new CapturingCodeRunner({}))),
      /Code node runner must return a DataValue for the Output port\./,
    );
  });

  it('rejects runner outputs that do not use the fixed any output contract', async () => {
    const node = createNode({
      code: 'return "ignored by this test runner";',
    });

    await assert.rejects(
      () =>
        node.process(
          {},
          createContext(
            new CapturingCodeRunner({
              output: {
                type: 'string',
                value: 'not the Code wrapper contract',
              },
            }),
          ),
        ),
      /Code node runner must return an any DataValue for the Output port\./,
    );
  });

  it('adds Code line information to runtime errors', async () => {
    const node = createNode({
      code: ['const first = 1;', 'const second = 2;', 'return missingVariable;'].join('\n'),
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof ReferenceError);
        assert.match(error.message, /missingVariable is not defined/);
        assert.match(error.message, /Code node line 3, column \d+/);
        assert.match(
          error.stack ?? '',
          /^ReferenceError: missingVariable is not defined \(Code node line 3, column \d+\)/,
        );
        return true;
      },
    );
  });

  it('adds Code line information to syntax errors', async () => {
    const node = createNode({
      code: ['const first = 1;', 'if (first {', '  return first;', '}'].join('\n'),
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'SyntaxError');
        assert.match(error.message, /Code node line 2, column \d+/);
        return true;
      },
    );
  });

  it('does not expose generated internal input names in runtime errors', async () => {
    const node = createNode({
      code: 'return {{missing}}();',
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /missing/);
        assert.doesNotMatch(error.message, /__codeNewInputs/);
        return true;
      },
    );
  });
});
