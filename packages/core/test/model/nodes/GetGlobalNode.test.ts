import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { GetGlobalNodeImpl, type Inputs, type InternalProcessContext, type NodeConnection } from '../../../src/index.js';
import { deserializeConnection, serializeConnection } from '../../../src/utils/serialization/serializationHelpers.js';

describe('GetGlobalNode', () => {
  it('waits by default instead of returning an on-demand function', () => {
    const node = GetGlobalNodeImpl.create();

    assert.equal(node.data.onDemand, false);
    assert.equal(node.data.wait, true);
  });

  it('marks On Demand and Wait as mutually exclusive editor toggles', () => {
    const node = new GetGlobalNodeImpl(GetGlobalNodeImpl.create());
    const editors = node.getEditors();

    assert.deepStrictEqual(
      editors.map((editor) => ({
        type: editor.type,
        label: editor.label,
        dataKey: 'dataKey' in editor ? editor.dataKey : undefined,
        includeInGraphSearch: editor.includeInGraphSearch,
        turnOffDataKeysWhenEnabled: editor.type === 'toggle' ? editor.turnOffDataKeysWhenEnabled : undefined,
      })),
      [
        {
          type: 'custom',
          label: 'Variable ID',
          dataKey: 'id',
          includeInGraphSearch: true,
          turnOffDataKeysWhenEnabled: undefined,
        },
        {
          type: 'dataTypeSelector',
          label: 'Data Type',
          dataKey: 'dataType',
          includeInGraphSearch: undefined,
          turnOffDataKeysWhenEnabled: undefined,
        },
        {
          type: 'toggle',
          label: 'On Demand',
          dataKey: 'onDemand',
          includeInGraphSearch: undefined,
          turnOffDataKeysWhenEnabled: ['wait'],
        },
        {
          type: 'toggle',
          label: 'Wait',
          dataKey: 'wait',
          includeInGraphSearch: undefined,
          turnOffDataKeysWhenEnabled: ['onDemand'],
        },
      ],
    );
  });

  it('uses a string input port for dynamic variable IDs regardless of value data type', () => {
    const chartNode = GetGlobalNodeImpl.create();
    chartNode.data.useIdInput = true;
    chartNode.data.dataType = 'number';

    const node = new GetGlobalNodeImpl(chartNode);

    assert.deepStrictEqual(node.getInputDefinitions(), [
      {
        id: 'id',
        title: 'Variable ID',
        dataType: 'string',
      },
    ]);
  });

  it('labels a fixed value output with its variable ID without changing saved connection IDs', () => {
    const source = GetGlobalNodeImpl.create();
    source.data.id = 'Foobar';
    const target = GetGlobalNodeImpl.create();
    target.data.useIdInput = true;
    const connection: NodeConnection = {
      outputNodeId: source.id,
      outputId: 'value' as NodeConnection['outputId'],
      inputNodeId: target.id,
      inputId: 'id' as NodeConnection['inputId'],
    };
    const restoredConnection = deserializeConnection(serializeConnection(connection, [source, target]), source.id);

    assert.deepEqual(restoredConnection, connection);
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.title, 'Foobar');
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.id, restoredConnection.outputId);

    source.data.id = 'Renamed';
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.title, 'Renamed');
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.id, restoredConnection.outputId);

    source.data.useIdInput = true;
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.title, 'Value');
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.id, restoredConnection.outputId);

    source.data.useIdInput = false;
    source.data.id = ' ';
    assert.equal(new GetGlobalNodeImpl(source).getOutputDefinitions()[0]?.title, 'Value');
  });

  it('uses one searchable Variable ID editor with the existing input-port toggle', () => {
    const editors = new GetGlobalNodeImpl(GetGlobalNodeImpl.create()).getEditors();

    assert.equal(editors.filter((editor) => editor.label === 'Variable ID').length, 1);
    assert.deepEqual(editors[0], {
      type: 'custom',
      label: 'Variable ID',
      customEditorId: 'GetGlobalVariableSelector',
      dataKey: 'id',
      useInputToggleDataKey: 'useIdInput',
      includeInGraphSearch: true,
      autoFocus: true,
    });
  });

  it('returns the variable ID output in on-demand mode', async () => {
    const chartNode = GetGlobalNodeImpl.create();
    chartNode.data.id = 'static-id';
    chartNode.data.onDemand = true;
    chartNode.data.wait = false;
    const node = new GetGlobalNodeImpl(chartNode);
    const context = {
      getGlobal: (id: string) => (id === 'static-id' ? { type: 'string', value: 'global value' } : undefined),
    } as InternalProcessContext;

    const outputs = await node.process({} as Inputs, context);

    assert.deepEqual(outputs['variable_id_out'], { type: 'string', value: 'static-id' });
    assert.equal(outputs.value?.type, 'fn<string>');
    assert.equal(typeof outputs.value?.value, 'function');
    assert.equal((outputs.value?.value as () => unknown)(), 'global value');
  });

  it('returns isolated object defaults in immediate and on-demand modes', async () => {
    const context = {
      getGlobal: () => undefined,
    } as InternalProcessContext;

    const immediateChartNode = GetGlobalNodeImpl.create();
    immediateChartNode.data.dataType = 'object';
    immediateChartNode.data.wait = false;
    const immediateNode = new GetGlobalNodeImpl(immediateChartNode);
    const firstImmediate = await immediateNode.process({} as Inputs, context);
    (firstImmediate.value?.value as Record<string, unknown>).leaked = true;
    const secondImmediate = await immediateNode.process({} as Inputs, context);
    assert.deepEqual(secondImmediate.value?.value, {});

    const onDemandChartNode = GetGlobalNodeImpl.create();
    onDemandChartNode.data.dataType = 'object';
    onDemandChartNode.data.onDemand = true;
    onDemandChartNode.data.wait = false;
    const onDemandNode = new GetGlobalNodeImpl(onDemandChartNode);
    const onDemandOutputs = await onDemandNode.process({} as Inputs, context);
    const getOnDemandValue = onDemandOutputs.value?.value as () => Record<string, unknown>;
    const firstOnDemand = getOnDemandValue();
    firstOnDemand.leaked = true;
    assert.deepEqual(getOnDemandValue(), {});
  });

  it('rejects on-demand plus wait before reading dynamic IDs', async () => {
    const chartNode = GetGlobalNodeImpl.create();
    chartNode.data.onDemand = true;
    chartNode.data.wait = true;
    chartNode.data.useIdInput = true;
    const node = new GetGlobalNodeImpl(chartNode);

    await assert.rejects(
      () => node.process({} as Inputs, {} as InternalProcessContext),
      /Cannot use onDemand and wait together/,
    );
  });
});
