import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  ArrayNodeImpl,
  GraphOutputNodeImpl,
  GraphProcessor,
  TextNodeImpl,
  ToBase64NodeImpl,
  globalRivetNodeRegistry,
  type DataValue,
  type PortId,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils.js';

const node = new ToBase64NodeImpl(ToBase64NodeImpl.create());

async function encode(input: DataValue): Promise<string> {
  const output = await node.process({ ['data' as PortId]: input });
  assert.equal(output.base64?.type, 'string');
  return output.base64.value as string;
}

function expected(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('ToBase64Node', () => {
  it('registers a required any input that preserves arrays and a string output', () => {
    assert.deepEqual(node.getInputDefinitions(), [
      {
        id: 'data',
        title: 'Data',
        dataType: 'any',
        required: true,
        coerced: false,
        splitRunBehavior: 'preserve-array',
      },
    ]);
    assert.deepEqual(node.getOutputDefinitions(), [{ id: 'base64', title: 'Base64', dataType: 'string' }]);
  });

  it('encodes strings as UTF-8 and JSON values as compact UTF-8 JSON', async () => {
    assert.equal(await encode({ type: 'string', value: 'Привет 🌍' }), expected('Привет 🌍'));
    assert.equal(await encode({ type: 'number', value: 12.5 }), expected('12.5'));
    assert.equal(await encode({ type: 'boolean', value: false }), expected('false'));
    assert.equal(await encode({ type: 'object', value: { answer: 42 } }), expected('{"answer":42}'));
    assert.equal(await encode({ type: 'any', value: runInNewContext('({ answer: 42 })') }), expected('{"answer":42}'));
    assert.equal(await encode({ type: 'string[]', value: ['a', 'b'] }), expected('["a","b"]'));
    assert.equal(await encode({ type: 'any', value: null }), expected('null'));
    assert.equal(await encode({ type: 'any', value: { omitted: undefined, answer: 42 } }), expected('{"answer":42}'));
  });

  it('encodes binary and media payload bytes without their metadata', async () => {
    const bytes = new Uint8Array([0, 128, 255]);
    const encoded = Buffer.from(bytes).toString('base64');
    assert.equal(await encode({ type: 'binary', value: bytes }), encoded);
    assert.equal(await encode({ type: 'image', value: { mediaType: 'image/png', data: bytes } }), encoded);
    assert.equal(await encode({ type: 'audio', value: { mediaType: 'audio/wav', data: bytes } }), encoded);
    assert.equal(
      await encode({
        type: 'document',
        value: {
          mediaType: 'application/pdf',
          data: bytes,
          title: undefined,
          context: undefined,
          enableCitations: false,
        },
      }),
      encoded,
    );
    assert.equal(await encode({ type: 'any', value: bytes }), encoded);
  });

  it('encodes byte containers from an any input without JSON-stringifying them', async () => {
    const bytes = new Uint8Array([0, 128, 255, 42]);
    const expectedBase64 = Buffer.from(bytes).toString('base64');
    assert.equal(await encode({ type: 'any', value: bytes.buffer }), expectedBase64);
    assert.equal(
      await encode({ type: 'any', value: new DataView(bytes.buffer, 1, 2) }),
      Buffer.from([128, 255]).toString('base64'),
    );
    assert.equal(await encode({ type: 'any', value: new Blob([bytes]) }), expectedBase64);
  });

  it('encodes a connected array once in a split-run graph', async () => {
    const first = TextNodeImpl.create();
    first.data.text = 'a';
    const second = TextNodeImpl.create();
    second.data.text = 'b';
    const array = ArrayNodeImpl.create();
    const encoder = ToBase64NodeImpl.create();
    encoder.isSplitRun = true;
    const output = GraphOutputNodeImpl.create();
    output.data.dataType = 'string[]';
    const graphId = 'to-base64-array-graph';
    const graph = {
      metadata: { id: graphId, name: 'To Base64 array' },
      nodes: [first, second, array, encoder, output],
      connections: [
        { outputNodeId: first.id, outputId: 'output', inputNodeId: array.id, inputId: 'input1' },
        { outputNodeId: second.id, outputId: 'output', inputNodeId: array.id, inputId: 'input2' },
        { outputNodeId: array.id, outputId: 'output', inputNodeId: encoder.id, inputId: 'data' },
        { outputNodeId: encoder.id, outputId: 'base64', inputNodeId: output.id, inputId: 'value' },
      ],
    };
    const project = {
      metadata: { id: 'project', title: 'Project', mainGraphId: graphId },
      graphs: { [graphId]: graph },
      plugins: [],
    };

    const result = await new GraphProcessor(project as any, graphId as any, globalRivetNodeRegistry).processGraph(
      testProcessContext(),
    );
    assert.deepEqual(result.output, { type: 'string[]', value: [expected('["a","b"]')] });
  });

  it('rejects missing, invalid, and unserializable values', async () => {
    await assert.rejects(node.process({}), /No data to encode/);
    await assert.rejects(encode({ type: 'binary', value: 'not bytes' } as unknown as DataValue), /must contain bytes/);
    await assert.rejects(encode({ type: 'number', value: Number.NaN }), /Non-finite/);
    await assert.rejects(encode({ type: 'object', value: { number: Number.POSITIVE_INFINITY } }), /Non-finite/);
    await assert.rejects(encode({ type: 'any', value: new Map([['answer', 42]]) }), /Non-JSON objects/);
    await assert.rejects(encode({ type: 'any', value: { bytes: new Uint8Array([1, 2]) } }), /Non-JSON objects/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await assert.rejects(encode({ type: 'any', value: cycle }), /Cannot serialize input as JSON/);
    await assert.rejects(encode({ type: 'any', value: undefined }), /Cannot encode any/);
    await assert.rejects(encode({ type: 'any', value: BigInt(1) }), /Cannot serialize input as JSON/);
    await assert.rejects(encode({ type: 'fn<string>', value: () => 'text' }), /Cannot encode fn<string>/);
    await assert.rejects(
      encode({ type: 'control-flow-excluded', value: undefined }),
      /Cannot encode control-flow-excluded/,
    );
  });
});
