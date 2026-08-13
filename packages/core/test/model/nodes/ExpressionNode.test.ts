import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  ExpressionNodeImpl,
  IsomorphicCodeRunner,
  NotAllowedCodeRunner,
  type CodeRunner,
  type CodeRunnerOptions,
  interpolateExpressionSource,
  type ExpressionNode,
  type Inputs,
  type InternalProcessContext,
  type NodeBodySpec,
  type Outputs,
  type PortId,
} from '../../../src/index.js';

const createNode = (data: Partial<ExpressionNode['data']>) => {
  return new ExpressionNodeImpl({
    ...ExpressionNodeImpl.create(),
    data: {
      ...ExpressionNodeImpl.create().data,
      ...data,
    },
  });
};

const createContext = (codeRunner = new IsomorphicCodeRunner()) =>
  ({
    codeRunner,
    graphInputNodeValues: {},
    contextValues: {},
  }) as InternalProcessContext;

class CapturingCodeRunner implements CodeRunner {
  options: CodeRunnerOptions | undefined;

  async runCode(_code: string, _inputs: Inputs, options: CodeRunnerOptions): Promise<Outputs> {
    this.options = options;
    return {
      output: {
        type: 'any',
        value: 'captured',
      },
    };
  }
}

describe('ExpressionNode', () => {
  it('can create node', () => {
    const node = ExpressionNodeImpl.create();

    assert.strictEqual(node.type, 'expression');
    assert.strictEqual(node.title, 'Expression');
  });

  it('creates one code editor and no manual input/output editors', () => {
    const node = ExpressionNodeImpl.create();
    const editors = new ExpressionNodeImpl(node).getEditors();

    assert.deepStrictEqual(editors, [
      {
        type: 'code',
        label: 'Expression',
        helperMessage:
          'Use {{var}} to create input ports. Interpolated variables evaluate as the connected values. Node execution also provides "require" and "process". Browser execution provides "fetch", "console", and "Rivet".',
        dataKey: 'expression',
        language: 'javascript',
        interpolationSyntax: 'js-value',
        enableFolding: true,
      },
    ]);
  });

  it('always requests every runtime API, ignoring retired saved permission fields', async () => {
    const codeRunner = new CapturingCodeRunner();
    const node = createNode({ expression: '1' });
    (node.chartNode.data as Record<string, unknown>).allowRivet = false;

    await node.process({}, createContext(codeRunner));

    assert.deepStrictEqual(codeRunner.options, {
      includeConsole: true,
      includeFetch: true,
      includeProcess: true,
      includeRequire: true,
      includeRivet: true,
    });
  });

  it('renders a colorized expression preview body', () => {
    const node = createNode({
      expression: '{{a}} == "123" ?\n  {{b}} :\n  {{c}}',
    });

    assert.deepStrictEqual(node.getBody(), {
      type: 'colorized',
      text: '{{a}} == "123" ?\n  {{b}} :\n  {{c}}',
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    } satisfies NodeBodySpec);
  });

  it('creates interpolation-derived input ports and one fixed output', () => {
    const node = createNode({
      expression: '{{a}} == "123" ? {{b}} : {{c}}',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => [definition.id, definition.dataType]),
      [
        ['a', 'any'],
        ['b', 'any'],
        ['c', 'any'],
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

  it('evaluates a value-based ternary expression', async () => {
    const node = createNode({
      expression: '{{a}} == "123" ? {{b}} : {{c}}',
    });

    const result = await node.process(
      {
        ['a' as PortId]: { type: 'string', value: '123' },
        ['b' as PortId]: { type: 'string', value: 'yes' },
        ['c' as PortId]: { type: 'string', value: 'no' },
      },
      createContext(),
    );

    assert.deepStrictEqual(result, {
      output: {
        type: 'any',
        value: 'yes',
      },
    });
  });

  it('supports real numbers, booleans, arrays, objects, and null values', async () => {
    const node = createNode({
      expression: '({ num: {{num}}, bool: {{bool}}, first: {{arr}}[0], ok: {{obj}}.ok, nil: {{nil}} })',
    });

    const result = await node.process(
      {
        ['num' as PortId]: { type: 'number', value: 1 },
        ['bool' as PortId]: { type: 'boolean', value: true },
        ['arr' as PortId]: { type: 'any[]', value: ['foo', 'bar'] },
        ['obj' as PortId]: { type: 'object', value: { ok: true } },
        ['nil' as PortId]: { type: 'any', value: null },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, {
      num: 1,
      bool: true,
      first: 'foo',
      ok: true,
      nil: null,
    });
  });

  it('returns the first array item with bracket access', async () => {
    const node = createNode({
      expression: '{{array}}[0]',
    });

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'any[]', value: ['foo', 'bar'] },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 'foo');
  });

  it('returns a string input directly', async () => {
    const node = createNode({
      expression: '{{text}}',
    });

    const result = await node.process(
      {
        ['text' as PortId]: { type: 'string', value: 'foo bar' },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 'foo bar');
  });

  it('returns object properties with dot access', async () => {
    const node = createNode({
      expression: '{{object}}.field',
    });

    const result = await node.process(
      {
        ['object' as PortId]: { type: 'object', value: { field: 'value' } },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 'value');
  });

  it('does not mutate upstream array input values', async () => {
    const node = createNode({
      expression: '({{array}}.push("baz"), {{array}})',
    });
    const array = ['foo', 'bar'];

    const result = await node.process(
      {
        ['array' as PortId]: { type: 'any[]', value: array },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, ['foo', 'bar', 'baz']);
    assert.deepStrictEqual(array, ['foo', 'bar']);
  });

  it('does not mutate upstream object input values', async () => {
    const node = createNode({
      expression: '({{object}}.nested.key = "changed", {{object}})',
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

  it('keeps interpolation values available when expression scopes use generated helper names', async () => {
    const node = createNode({
      expression: '((__expressionInputs, expressionInputCloneCache) => {{value}})({}, new WeakMap())',
    });

    const result = await node.process(
      {
        ['value' as PortId]: { type: 'number', value: 7 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 7);
  });

  it('does not mutate upstream function input properties', async () => {
    const node = createNode({
      expression: '({{fn}}.meta.seen = true, {{fn}}(3))',
    });
    const fn = Object.assign((value: number) => value * 2, {
      meta: {
        seen: false,
      },
    });

    const result = await node.process(
      {
        ['fn' as PortId]: { type: 'any', value: fn },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 6);
    assert.deepStrictEqual(fn.meta, { seen: false });
  });

  it('preserves shared identity across cloned input references', async () => {
    const node = createNode({
      expression: '{{a}} === {{b}}',
    });
    const shared = { key: 'value' };

    const result = await node.process(
      {
        ['a' as PortId]: { type: 'object', value: shared },
        ['b' as PortId]: { type: 'object', value: shared },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, true);
  });

  it('treats missing interpolation inputs as undefined', async () => {
    const node = createNode({
      expression: 'typeof {{missing}}',
    });

    const result = await node.process({}, createContext());

    assert.deepStrictEqual(result.output?.value, 'undefined');
  });

  it('trims the parsed expression before evaluation', async () => {
    const node = createNode({
      expression: '\n  {{a}} + 1  \n',
    });

    const result = await node.process(
      {
        ['a' as PortId]: { type: 'number', value: 41 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, 42);
  });

  it('trims the parsed expression source used for debugging', () => {
    const parsedExpression = interpolateExpressionSource('\n  {{a}} == "123" ? {{b}} : {{c}}  \n', {
      ['a' as PortId]: { type: 'string', value: '123' },
      ['b' as PortId]: { type: 'string', value: 'yes' },
      ['c' as PortId]: { type: 'string', value: 'no' },
    });

    assert.equal(parsedExpression, '"123" == "123" ? "yes" : "no"');
  });

  it('discovers later valid interpolation tokens even when an earlier opener is broken', () => {
    const node = createNode({
      expression: '{{broken + {{value}}',
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['value'],
    );
  });

  it('keeps escaped interpolation tokens literal and does not create ports for them', async () => {
    const node = createNode({
      expression: '"{{{a}}}"',
    });

    assert.deepStrictEqual(node.getInputDefinitions(), []);

    const result = await node.process({}, createContext());

    assert.deepStrictEqual(result.output?.value, '{{a}}');
  });

  it('evaluates object literal expressions correctly', async () => {
    const node = createNode({
      expression: '{ value: {{value}}, nested: { ok: true } }',
    });

    const result = await node.process(
      {
        ['value' as PortId]: { type: 'number', value: 42 },
      },
      createContext(),
    );

    assert.deepStrictEqual(result.output?.value, {
      value: 42,
      nested: { ok: true },
    });
  });

  it('throws on invalid JavaScript after interpolation', async () => {
    const node = createNode({
      expression: '{{a}} +',
    });

    await assert.rejects(
      () =>
        node.process(
          {
            ['a' as PortId]: { type: 'number', value: 1 },
          },
          createContext(),
        ),
      /Unexpected token|Unexpected end of input|missing/i,
    );
  });

  it('respects disabled dynamic code execution', async () => {
    const node = createNode({
      expression: '1 + 1',
    });

    await assert.rejects(
      () => node.process({}, createContext(new NotAllowedCodeRunner())),
      /Dynamic code execution is disabled\./,
    );
  });

  it('does not expose generated internal input names in runtime errors', async () => {
    const node = createNode({
      expression: '{{missing}}()',
    });

    await assert.rejects(
      () => node.process({}, createContext()),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /missing/);
        assert.doesNotMatch(error.message, /__expressionInputs/);
        return true;
      },
    );
  });
});
