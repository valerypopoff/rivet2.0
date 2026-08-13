import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  GraphProcessor,
  MatchNodeImpl,
  globalRivetNodeRegistry,
  matchNode,
  type MatchNode,
  type PortId,
} from '../../../src/index.js';
import { testProcessContext } from '../../testUtils.js';

const createNode = (data: Partial<MatchNode['data']>) => {
  return new MatchNodeImpl({
    ...MatchNodeImpl.create(),
    data: {
      ...MatchNodeImpl.create().data,
      ...data,
    },
  });
};

function makeProject(graph: object) {
  return {
    metadata: {
      id: 'project-1',
      title: 'Project',
      description: '',
      mainGraphId: 'match-graph',
    },
    graphs: {
      'match-graph': graph,
    },
    plugins: [],
  } as any;
}

describe('MatchNode', () => {
  it('uses Regex Match for UI labels while preserving the match node type', () => {
    const node = MatchNodeImpl.create();
    const uiData = MatchNodeImpl.getUIData();

    assert.equal(node.type, 'match');
    assert.equal(node.title, 'Regex Match');
    assert.equal(matchNode.displayName, 'Regex Match');
    assert.equal(uiData.contextMenuTitle, 'Regex Match');
    assert.equal(uiData.infoBoxTitle, 'Regex Match Node');
  });

  it('renders compact routing-mode text and edits the existing exclusive boolean with a selector', () => {
    const allMatches = createNode({
      cases: ['YES', 'NO'],
      exclusive: false,
      valueInputMode: 'shared',
    });
    const firstMatch = createNode({
      cases: ['YES', 'NO'],
      exclusive: true,
      valueInputMode: 'per-output',
    });

    assert.equal(allMatches.getBody(), 'Trigger all matching cases');
    assert.equal(firstMatch.getBody(), 'Trigger the first matching case only');

    const routingModeEditor = allMatches
      .getEditors()
      .find((editor) => editor.type === 'segmented' && editor.dataKey === 'exclusive');
    assert.equal(routingModeEditor?.label, 'Matching cases to trigger');
    assert.deepEqual(routingModeEditor?.options, [
      { value: false, label: 'Trigger all matching cases' },
      { value: true, label: 'Trigger first only' },
    ]);
    const valueModeEditor = allMatches
      .getEditors()
      .find((editor) => editor.type === 'segmented' && editor.dataKey === 'valueInputMode');
    assert.deepEqual(valueModeEditor?.options, [
      { value: 'shared', label: 'One shared custom value' },
      { value: 'per-output', label: 'Custom values per case' },
    ]);
    assert.deepEqual(
      allMatches.getEditors().map((editor) => editor.label),
      ['Matching cases to trigger', 'Custom case values', 'Cases (regular expressions)'],
    );
  });

  it('uses legacy output ids when stored case port ids are absent', async () => {
    const node = createNode({
      cases: ['YES', 'NO'],
      casePortIds: undefined,
    });

    assert.deepEqual(
      node.getOutputDefinitions().map(({ id, title }) => ({ id, title })),
      [
        { id: 'case1', title: 'YES' },
        { id: 'case2', title: 'NO' },
        { id: 'unmatched', title: 'Unmatched' },
      ],
    );

    const output = await node.process({
      input: {
        type: 'string',
        value: 'YES',
      },
    } as Record<PortId, any>);

    assert.equal(output['case1' as PortId]?.value, 'YES');
    assert.equal(output['case2' as PortId]?.type, 'control-flow-excluded');
    assert.equal(output['unmatched' as PortId]?.type, 'control-flow-excluded');
  });

  it('defaults missing value input mode to the legacy shared value behavior', async () => {
    const node = createNode({
      cases: ['YES'],
      casePortIds: ['case-yes'],
      valueInputMode: undefined,
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title, required }) => ({ id, title, required })),
      [
        { id: 'input', title: 'Test', required: true },
        { id: 'value', title: 'Custom value', required: undefined },
      ],
    );
    assert.ok(node.getOutputDefinitions().every(({ dataType }) => dataType === 'any'));

    const output = await node.process({
      input: { type: 'string', value: 'YES' },
      value: { type: 'object', value: { shared: true } },
    } as Record<PortId, any>);

    assert.deepEqual(output['case-yes' as PortId], {
      type: 'object',
      value: { shared: true },
    });
  });

  it('exposes optional paired values and emits the matching values independently', async () => {
    const node = createNode({
      cases: ['foo', 'bar'],
      casePortIds: ['case-foo', 'case-bar'],
      valueInputMode: 'per-output',
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title, required }) => ({ id, title, required })),
      [
        { id: 'input', title: 'Test', required: true },
        { id: 'value-case-foo', title: 'foo', required: undefined },
        { id: 'value-case-bar', title: 'bar', required: undefined },
        { id: 'value-unmatched', title: 'Unmatched', required: undefined },
      ],
    );

    const output = await node.process({
      input: { type: 'string', value: 'foo and bar' },
      'value-case-foo': { type: 'number', value: 1 },
      'value-case-bar': { type: 'object', value: { branch: 'bar' } },
      'value-unmatched': { type: 'boolean', value: false },
    } as Record<PortId, any>);

    assert.deepEqual(output['case-foo' as PortId], { type: 'number', value: 1 });
    assert.deepEqual(output['case-bar' as PortId], { type: 'object', value: { branch: 'bar' } });
    assert.equal(output['unmatched' as PortId]?.type, 'control-flow-excluded');
  });

  it('passes a connected per-case value through a complete graph run without waiting for unused value ports', async () => {
    const graph = {
      metadata: { id: 'match-graph', name: 'Match graph', description: '' },
      nodes: [
        {
          id: 'test',
          type: 'text',
          title: 'Test',
          data: { text: 'YES' },
          visualData: { x: 0, y: 0, width: 120 },
        },
        {
          id: 'yes-value',
          type: 'text',
          title: 'Yes value',
          data: { text: 'sent through' },
          visualData: { x: 0, y: 120, width: 120 },
        },
        {
          id: 'match',
          type: 'match',
          title: 'Regex Match',
          data: {
            cases: ['YES', 'NO'],
            casePortIds: ['case-yes', 'case-no'],
            valueInputMode: 'per-output',
          },
          visualData: { x: 240, y: 0, width: 180 },
        },
        {
          id: 'output',
          type: 'graphOutput',
          title: 'Graph Output',
          data: { id: 'result', dataType: 'string' },
          visualData: { x: 480, y: 0, width: 180 },
        },
      ],
      connections: [
        { outputNodeId: 'test', outputId: 'output', inputNodeId: 'match', inputId: 'input' },
        {
          outputNodeId: 'yes-value',
          outputId: 'output',
          inputNodeId: 'match',
          inputId: 'value-case-yes',
        },
        { outputNodeId: 'match', outputId: 'case-yes', inputNodeId: 'output', inputId: 'value' },
      ],
    };

    const processor = new GraphProcessor(makeProject(graph), 'match-graph' as any, globalRivetNodeRegistry);
    const outputs = await processor.processGraph(testProcessContext());

    assert.deepEqual(outputs.result, { type: 'string', value: 'sent through' });
  });

  it('uses Unmatched Value in per-output mode when the test is missing or no case matches', async () => {
    const node = createNode({
      cases: ['YES'],
      casePortIds: ['case-yes'],
      valueInputMode: 'per-output',
    });

    for (const input of [undefined, 'NO']) {
      const output = await node.process({
        ...(input === undefined ? {} : { input: { type: 'string', value: input } }),
        'value-case-yes': { type: 'string', value: 'yes' },
        'value-unmatched': { type: 'object', value: { unmatched: true } },
      } as Record<PortId, any>);

      assert.equal(output['case-yes' as PortId]?.type, 'control-flow-excluded');
      assert.deepEqual(output['unmatched' as PortId], {
        type: 'object',
        value: { unmatched: true },
      });
    }
  });

  it('only emits the first matching paired value in exclusive per-output mode', async () => {
    const node = createNode({
      cases: ['foo', 'foo'],
      casePortIds: ['first', 'second'],
      valueInputMode: 'per-output',
      exclusive: true,
    });

    const output = await node.process({
      input: { type: 'string', value: 'foo' },
      'value-first': { type: 'string', value: 'first result' },
      'value-second': { type: 'string', value: 'second result' },
      'value-unmatched': { type: 'string', value: 'not matched' },
    } as Record<PortId, any>);

    assert.deepEqual(output.first, { type: 'string', value: 'first result' });
    assert.equal(output.second?.type, 'control-flow-excluded');
    assert.equal(output.unmatched?.type, 'control-flow-excluded');
  });

  it('uses stored case port ids and keeps process outputs aligned with output definitions', async () => {
    const node = createNode({
      cases: ['YES', 'NO'],
      casePortIds: ['case-yes', 'case-no'],
    });

    assert.deepEqual(
      node.getOutputDefinitions().map(({ id, title }) => ({ id, title })),
      [
        { id: 'case-yes', title: 'YES' },
        { id: 'case-no', title: 'NO' },
        { id: 'unmatched', title: 'Unmatched' },
      ],
    );

    const output = await node.process({
      input: {
        type: 'string',
        value: 'NO',
      },
    } as Record<PortId, any>);

    assert.equal(output['case-yes' as PortId]?.type, 'control-flow-excluded');
    assert.equal(output['case-no' as PortId]?.value, 'NO');
    assert.equal(output['unmatched' as PortId]?.type, 'control-flow-excluded');
  });

  it('routes missing, null, and undefined test values to Unmatched', async () => {
    const node = createNode({ cases: ['YES'] });
    const cases = [
      { label: 'missing', inputs: {} },
      { label: 'null', inputs: { input: { type: 'any', value: null } } },
      { label: 'undefined', inputs: { input: { type: 'any', value: undefined } } },
    ] as const;

    for (const { label, inputs } of cases) {
      const output = await node.process(inputs as Record<PortId, any>);

      assert.equal(output['case1' as PortId]?.type, 'control-flow-excluded', label);
      assert.equal(output['unmatched' as PortId]?.type, 'string', label);
      assert.equal(output['unmatched' as PortId]?.value, undefined, label);
    }
  });

  it('still matches an empty string test value', async () => {
    const node = createNode({ cases: ['^$'] });
    const output = await node.process({
      input: {
        type: 'string',
        value: '',
      },
    } as Record<PortId, any>);

    assert.equal(output['case1' as PortId]?.value, '');
    assert.equal(output['unmatched' as PortId]?.type, 'control-flow-excluded');
  });
});
