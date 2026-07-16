import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { MatchNodeImpl, matchNode, type MatchNode, type PortId } from '../../../src/index.js';

const createNode = (data: Partial<MatchNode['data']>) => {
  return new MatchNodeImpl({
    ...MatchNodeImpl.create(),
    data: {
      ...MatchNodeImpl.create().data,
      ...data,
    },
  });
};

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
