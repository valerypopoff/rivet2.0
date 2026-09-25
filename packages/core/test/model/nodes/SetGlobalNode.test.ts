import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  SetGlobalNodeImpl,
  type Inputs,
  type InternalProcessContext,
  type NodeConnection,
  type ScalarOrArrayDataValue,
} from '../../../src/index.js';
import { deserializeConnection, serializeConnection } from '../../../src/utils/serialization/serializationHelpers.js';

describe('SetGlobalNode', () => {
  it('labels fixed-ID outputs without changing saved connection IDs', () => {
    const source = SetGlobalNodeImpl.create();
    source.data.id = 'Foobar';
    const target = SetGlobalNodeImpl.create();
    target.data.useIdInput = true;
    const connections: NodeConnection[] = [
      {
        outputNodeId: source.id,
        outputId: 'saved-value' as NodeConnection['outputId'],
        inputNodeId: target.id,
        inputId: 'value' as NodeConnection['inputId'],
      },
      {
        outputNodeId: source.id,
        outputId: 'previous-value' as NodeConnection['outputId'],
        inputNodeId: target.id,
        inputId: 'id' as NodeConnection['inputId'],
      },
    ];
    const restored = connections.map((connection) =>
      deserializeConnection(serializeConnection(connection, [source, target]), source.id),
    );

    assert.deepEqual(restored, connections);
    const outputs = new SetGlobalNodeImpl(source).getOutputDefinitions();
    assert.deepEqual(outputs.map(({ id, title }) => ({ id, title })), [
      { id: restored[0]!.outputId, title: 'Foobar' },
      { id: restored[1]!.outputId, title: 'Prev value of: Foobar' },
      { id: 'variable_id_out', title: 'Variable ID' },
    ]);

    source.data.id = 'Renamed';
    assert.deepEqual(
      new SetGlobalNodeImpl(source).getOutputDefinitions().slice(0, 2).map(({ id, title }) => ({ id, title })),
      [
        { id: restored[0]!.outputId, title: 'Renamed' },
        { id: restored[1]!.outputId, title: 'Prev value of: Renamed' },
      ],
    );

    source.data.useIdInput = true;
    assert.deepEqual(new SetGlobalNodeImpl(source).getOutputDefinitions().slice(0, 2).map(({ title }) => title), [
      'Value',
      'Previous Value',
    ]);
    assert.match(new SetGlobalNodeImpl(source).getBody() as string, /\(ID from input\)/);

    source.data.useIdInput = false;
    source.data.id = ' ';
    assert.deepEqual(new SetGlobalNodeImpl(source).getOutputDefinitions().slice(0, 2).map(({ title }) => title), [
      'Value',
      'Previous Value',
    ]);
  });

  it('marks the variable ID editor as searchable by graph search', () => {
    const node = new SetGlobalNodeImpl(SetGlobalNodeImpl.create());
    const idEditor = node.getEditors().find((editor) => 'dataKey' in editor && editor.dataKey === 'id');

    assert.equal(idEditor?.includeInGraphSearch, true);
  });

  it('reads the previous value from the dynamic variable ID input', async () => {
    const chartNode = SetGlobalNodeImpl.create();
    chartNode.data.id = 'static-id';
    chartNode.data.useIdInput = true;

    const globals = new Map<string, ScalarOrArrayDataValue>([
      ['static-id', { type: 'string', value: 'static old value' }],
      ['dynamic-id', { type: 'string', value: 'dynamic old value' }],
    ]);
    const context = {
      getGlobal: (id: string) => globals.get(id),
      setGlobal: (id: string, value: ScalarOrArrayDataValue) => {
        globals.set(id, value);
      },
    } as InternalProcessContext;
    const node = new SetGlobalNodeImpl(chartNode);

    const outputs = await node.process(
      {
        value: { type: 'string', value: 'new value' },
        id: { type: 'string', value: 'dynamic-id' },
      } as Inputs,
      context,
    );

    assert.deepEqual(outputs['previous-value'], { type: 'string', value: 'dynamic old value' });
    assert.deepEqual(globals.get('dynamic-id'), { type: 'string', value: 'new value' });
    assert.deepEqual(globals.get('static-id'), { type: 'string', value: 'static old value' });
  });
});
