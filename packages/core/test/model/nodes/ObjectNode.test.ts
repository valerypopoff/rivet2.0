import { it, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { type DataValue, type InternalProcessContext, type ObjectNode, ObjectNodeImpl } from '../../../src/index.js';

/* eslint-disable @typescript-eslint/no-floating-promises */

const createNode = (data: Partial<ObjectNode['data']>) => {
  return new ObjectNodeImpl({
    ...ObjectNodeImpl.create(),
    data: {
      ...ObjectNodeImpl.create().data,
      ...data,
    },
  });
};

describe('ObjectNodeImpl', () => {
  const ctx = {} as InternalProcessContext;

  it('can create node', () => {
    const node = ObjectNodeImpl.create();
    assert.strictEqual(node.type, 'object');
  });

  it('marks the JSON template editor as JSON with template interpolation syntax', () => {
    const node = ObjectNodeImpl.create();
    const editors = new ObjectNodeImpl(node).getEditors();

    assert.deepStrictEqual(editors[1], {
      type: 'code',
      label: 'JSON Template',
      dataKey: 'jsonTemplate',
      language: 'json',
      interpolationSyntax: 'json-template',
      theme: 'prompt-interpolation',
      enableFolding: true,
    });
  });

  it('supports strings with quote characters', async () => {
    const node = createNode({ jsonTemplate: `{"key": "{{input}}"}` });
    const inputs: Record<string, DataValue> = {
      input: { type: 'string', value: 'You say "goodbye," I say "hello."' },
    };
    const result = await node.process(inputs, ctx);
    assert.deepStrictEqual(result['output'].value, { key: 'You say "goodbye," I say "hello."' });
  });

  it('supports strings strings without quote characters', async () => {
    // Note lack of double-quotes around {{inputs}}
    const node = createNode({ jsonTemplate: `{"key": {{input}} }` });
    const inputs: Record<string, DataValue> = {
      input: { type: 'string', value: 'You say "goodbye," I say "hello."' },
    };
    const result = await node.process(inputs, ctx);
    assert.deepStrictEqual(result['output'].value, { key: 'You say "goodbye," I say "hello."' });
  });

  it('supports embedded string interpolation with suffix text', async () => {
    const node = createNode({ jsonTemplate: `{"key": "{{input}}. That's it."}` });
    const emptyResult = await node.process({ input: { type: 'string', value: '' } }, ctx);
    const valueResult = await node.process({ input: { type: 'string', value: 'Done' } }, ctx);

    assert.deepStrictEqual(emptyResult['output'].value, { key: ". That's it." });
    assert.deepStrictEqual(valueResult['output'].value, { key: "Done. That's it." });
  });

  it('supports embedded string interpolation before, between, and after static text', async () => {
    const node = createNode({ jsonTemplate: `{"key": "Before {{first}} middle {{second}} after"}` });
    const result = await node.process(
      {
        first: { type: 'string', value: 'A' },
        second: { type: 'string', value: 'B' },
      },
      ctx,
    );

    assert.deepStrictEqual(result['output'].value, { key: 'Before A middle B after' });
  });

  it('escapes embedded string interpolation fragments inside JSON strings', async () => {
    const node = createNode({ jsonTemplate: `{"key": "Before {{input}} after"}` });
    const value = 'Line "quoted" with \\ backslash\nnext line';
    const result = await node.process({ input: { type: 'string', value } }, ctx);

    assert.deepStrictEqual(result['output'].value, { key: `Before ${value} after` });
  });

  it('treats tokens next to escaped quotes as embedded string interpolation', async () => {
    const node = createNode({ jsonTemplate: `{"key": "Before \\"{{input}}\\" after"}` });
    const result = await node.process({ input: { type: 'string', value: 'A' } }, ctx);

    assert.deepStrictEqual(result['output'].value, { key: 'Before "A" after' });
  });

  it('renders embedded non-string values as JSON text inside JSON strings', async () => {
    const node = createNode({
      jsonTemplate: `{"key": "{{obj}}|{{arr}}|{{num}}|{{bool}}"}`,
    });
    const result = await node.process(
      {
        obj: { type: 'object', value: { a: 1 } },
        arr: { type: 'any[]', value: [1, 'two'] },
        num: { type: 'number', value: 42 },
        bool: { type: 'boolean', value: false },
      },
      ctx,
    );

    assert.deepStrictEqual(result['output'].value, { key: '{"a":1}|[1,"two"]|42|false' });
  });

  it('renders embedded null and undefined values as null text inside JSON strings', async () => {
    const node = createNode({ jsonTemplate: `{"key": "{{nil}}|{{undefinedValue}}"}` });
    const result = await node.process(
      {
        nil: { type: 'any', value: null },
        undefinedValue: { type: 'any', value: undefined },
      },
      ctx,
    );

    assert.deepStrictEqual(result['output'].value, { key: 'null|null' });
  });

  it('turns any key surrounded by double-quotes into escaped strings', async () => {
    const node = createNode({ jsonTemplate: `{"key": "{{input}}"}` });
    const inputs: Record<string, DataValue> = {
      input: { type: 'object', value: { you: 'goodbye', me: 'hello' } },
    };
    const result = await node.process(inputs, ctx);

    const keyValue = (result['output'].value as any)['key'];
    assert.strictEqual(typeof keyValue, 'string');
    assert.deepStrictEqual(JSON.parse(keyValue), { you: 'goodbye', me: 'hello' });
  });

  it('does not escape objects', async () => {
    const node = createNode({ jsonTemplate: `{"key": {{input}}}` });
    const inputs: Record<string, DataValue> = {
      input: { type: 'object', value: { you: 'goodbye', me: 'hello' } },
    };
    const result = await node.process(inputs, ctx);

    assert.deepEqual(result['output'].value, { key: { you: 'goodbye', me: 'hello' } });
  });

  it('does not escape booleans', async () => {
    const node = createNode({ jsonTemplate: `{"key": {{input}}, "anotherKey": {{anotherInput}}}` });
    const inputs: Record<string, DataValue> = {
      input: { type: 'boolean', value: false },
      anotherInput: { type: 'boolean', value: true },
    };
    const result = await node.process(inputs, ctx);

    assert.deepStrictEqual(result['output'].value, { key: false, anotherKey: true });
  });

  it('does not escape numbers', async () => {
    const node = createNode({ jsonTemplate: `{"key": {{input}}, "anotherKey": {{anotherInput}}}` });
    const inputs: Record<string, DataValue> = {
      input: { type: 'number', value: 0 },
      anotherInput: { type: 'number', value: 2 },
    };
    const result = await node.process(inputs, ctx);

    assert.deepStrictEqual(result['output'].value, { key: 0, anotherKey: 2 });
  });

  it('does not escape arrays', async () => {
    const node = createNode({
      jsonTemplate: `{"numArray": {{numArray}}, "strArray": {{strArray}}, "anyArray": {{anyArray}}, "objArray": {{objArray}}}`,
    });
    const inputs: Record<string, DataValue> = {
      numArray: { type: 'number[]', value: [1, 2, 3] },
      strArray: { type: 'string[]', value: ['hello'] },
      anyArray: { type: 'any[]', value: ['world'] },
      objArray: { type: 'object[]', value: [] },
    };
    const result = await node.process(inputs, ctx);

    assert.deepEqual(result['output'].value, {
      numArray: [1, 2, 3],
      strArray: ['hello'],
      anyArray: ['world'],
      objArray: [],
    });
  });

  it('uses one base input to insert a JSONPath-selected nested value with its original type', async () => {
    const node = createNode({ jsonTemplate: `{"selected": {{payload.records[0].value}}}` });
    const result = await node.process(
      {
        payload: {
          type: 'object',
          value: {
            records: [
              {
                value: {
                  type: 'ordinary-json',
                  value: 42,
                },
              },
            ],
          },
        },
      },
      ctx,
    );

    assert.deepStrictEqual(result.output.value, {
      selected: {
        type: 'ordinary-json',
        value: 42,
      },
    });
    assert.deepStrictEqual(
      node.getInputDefinitions().map(({ id, dataType }) => ({ id, dataType })),
      [{ id: 'payload', dataType: 'any' }],
    );
  });

  it('allows variables to be used multiple times, both escaped and unescaped', async () => {
    const node = createNode({
      jsonTemplate: `{
      "obj": {{obj}},
      "objStr": "{{obj}}",
      "nested": {
        "obj": {{obj}}
      }
    }`,
    });
    const inputs: Record<string, DataValue> = {
      obj: { type: 'object', value: { hello: 'world' } },
    };
    const result = await node.process(inputs, ctx);

    assert.deepStrictEqual(result['output'].value, {
      obj: { hello: 'world' },
      objStr: '{"hello":"world"}',
      nested: {
        obj: { hello: 'world' },
      },
    });
  });

  it('supports fully undefined inputs', async () => {
    const node = createNode({ jsonTemplate: `{"key": "{{input}}"}` });
    const inputs: Record<string, DataValue> = {
      input: undefined as any, // I believe this can happen when a split node has arrays of different lengths.
    };
    const result = await node.process(inputs, ctx);
    assert.deepStrictEqual(result['output'].value, { key: null });
  });

  it('discovers later valid inputs even when an earlier interpolation opener is broken', () => {
    const node = createNode({
      jsonTemplate: ['{"first": "{{foo}}",', '"broken": "{{bar",', '"second": "{{somevar}}"}'].join('\n'),
    });

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['foo', 'somevar'],
    );
  });

  it('keeps broken interpolation text literal while still resolving later valid values', async () => {
    const node = createNode({
      jsonTemplate: `{"first":"{{foo}}","broken":"{{bar","second":"{{somevar}}"}`,
    });
    const inputs: Record<string, DataValue> = {
      foo: { type: 'string', value: 'A' },
      somevar: { type: 'string', value: 'B' },
    };

    const result = await node.process(inputs, ctx);

    assert.deepStrictEqual(result['output'].value, {
      first: 'A',
      broken: '{{bar',
      second: 'B',
    });
  });

  it('keeps escaped interpolation tokens literal while still resolving normal tokens', async () => {
    const node = createNode({
      jsonTemplate: `{"literal":"{{{foo}}}","actual":"{{bar}}"}`,
    });
    const inputs: Record<string, DataValue> = {
      bar: { type: 'string', value: 'B' },
    };

    assert.deepStrictEqual(
      node.getInputDefinitions().map((definition) => definition.id),
      ['bar'],
    );

    const result = await node.process(inputs, ctx);

    assert.deepStrictEqual(result['output'].value, {
      literal: '{{foo}}',
      actual: 'B',
    });
  });

  it('does not reinterpret escaped-token syntax supplied by an interpolated value', async () => {
    const node = createNode({
      jsonTemplate: `{"triple":"{{triple}}","backslash":"{{backslash}}"}`,
    });
    const result = await node.process(
      {
        triple: { type: 'string', value: '{{{bar}}}' },
        backslash: { type: 'string', value: '\\{\\{bar\\}\\}' },
      },
      ctx,
    );

    assert.deepStrictEqual(result['output'].value, {
      triple: '{{{bar}}}',
      backslash: '\\{\\{bar\\}\\}',
    });
  });
});
