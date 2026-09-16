import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MatchCaseNodeImpl,
  matchCaseNode,
  type MatchCaseNode,
  type PortId,
} from '../../../src/index.js';

const createNode = (data: Partial<MatchCaseNode['data']>) => {
  const created = MatchCaseNodeImpl.create();
  return new MatchCaseNodeImpl({
    ...created,
    data: {
      ...created.data,
      ...data,
    },
  });
};

describe('MatchCaseNode', () => {
  it('is a distinct current node with plain-text matching selected by default', () => {
    const node = MatchCaseNodeImpl.create();
    const uiData = MatchCaseNodeImpl.getUIData();

    assert.equal(node.type, 'matchCase');
    assert.equal(node.title, 'Match case');
    assert.equal(matchCaseNode.displayName, 'Match case');
    assert.equal(uiData.contextMenuTitle, 'Match case');
    assert.equal(uiData.infoBoxTitle, 'Match case Node');
    assert.equal(node.data.matchMode, 'plainText');
    assert.equal(node.data.caseSensitive, true);
    assert.equal(node.data.exclusive, true);
    assert.equal(node.data.returnValue, 'true');

    const modeEditor = new MatchCaseNodeImpl(node)
      .getEditors()
      .find((editor) => editor.type === 'segmented' && editor.dataKey === 'matchMode');
    assert.deepEqual(modeEditor?.options, [
      { value: 'plainText', label: 'Plain text' },
      { value: 'regex', label: 'Regular expression' },
    ]);
    const triggerEditor = new MatchCaseNodeImpl(node)
      .getEditors()
      .find((editor) => editor.type === 'segmented' && editor.dataKey === 'exclusive');
    assert.equal(triggerEditor?.label, 'Trigger');
    assert.equal(triggerEditor?.defaultValue, true);
    assert.deepEqual(triggerEditor?.options, [
      { value: true, label: 'First matching case' },
      { value: false, label: 'All matching cases' },
    ]);
    const sensitivityEditor = new MatchCaseNodeImpl(node)
      .getEditors()
      .find((editor) => editor.type === 'toggle' && editor.dataKey === 'caseSensitive');
    assert.equal(sensitivityEditor?.label, 'Case sensitive');
    assert.equal(sensitivityEditor?.defaultValue, true);
    assert.equal(sensitivityEditor?.hideIf?.({ ...node.data, matchMode: 'regex' }), true);
    assert.equal(sensitivityEditor?.hideIf?.({ ...node.data, matchMode: 'plainText' }), false);

    const returnValueEditor = new MatchCaseNodeImpl(node)
      .getEditors()
      .find((editor) => editor.type === 'segmented' && editor.dataKey === 'returnValue');
    assert.equal(returnValueEditor?.label, 'Output value');
    assert.equal(returnValueEditor?.defaultValue, 'true');
    assert.deepEqual(returnValueEditor?.options, [
      { value: 'true', label: 'True' },
      { value: 'testValue', label: 'Input value' },
      { value: 'custom', label: 'Custom' },
    ]);

    const customCaseValuesEditor = new MatchCaseNodeImpl(node)
      .getEditors()
      .find((editor) => editor.type === 'segmented' && editor.dataKey === 'valueInputMode');
    assert.equal(customCaseValuesEditor?.hideIf?.({ ...node.data, returnValue: 'true' }), true);
    assert.equal(customCaseValuesEditor?.hideIf?.({ ...node.data, returnValue: 'testValue' }), true);
    assert.equal(customCaseValuesEditor?.hideIf?.({ ...node.data, returnValue: 'custom' }), false);
    assert.equal(customCaseValuesEditor?.label, '');
    assert.equal(customCaseValuesEditor?.ariaLabel, 'Custom case values');

    assert.deepEqual(
      new MatchCaseNodeImpl(node).getEditors().map((editor) => editor.dataKey),
      ['matchMode', 'caseSensitive', 'cases', 'exclusive', 'returnValue', 'valueInputMode'],
    );
  });

  it('uses exact, case-sensitive string equality in Plain text mode', async () => {
    const node = createNode({
      cases: ['a.b', 'YES'],
      casePortIds: ['literal', 'yes'],
      matchMode: 'plainText',
      returnValue: 'testValue',
    });

    const partial = await node.process({
      input: { type: 'string', value: 'axb' },
    } as Record<PortId, any>);
    assert.equal(partial.literal?.type, 'control-flow-excluded');
    assert.equal(partial.yes?.type, 'control-flow-excluded');
    assert.equal(partial.unmatched?.value, 'axb');

    const exact = await node.process({
      input: { type: 'string', value: 'a.b' },
    } as Record<PortId, any>);
    assert.equal(exact.literal?.value, 'a.b');
    assert.equal(exact.yes?.type, 'control-flow-excluded');
    assert.equal(exact.unmatched?.type, 'control-flow-excluded');
  });

  it('uses the existing JavaScript regular-expression behavior in Regular expression mode', async () => {
    const node = createNode({
      cases: ['a.b'],
      casePortIds: ['regex'],
      matchMode: 'regex',
      returnValue: 'testValue',
    });

    const output = await node.process({
      input: { type: 'string', value: 'axb' },
    } as Record<PortId, any>);

    assert.equal(output.regex?.value, 'axb');
    assert.equal(output.unmatched?.type, 'control-flow-excluded');
  });

  it('can ignore letter case in Plain text mode without changing Regular expression behavior', async () => {
    const caseInsensitive = createNode({
      cases: ['approved'],
      casePortIds: ['approved'],
      matchMode: 'plainText',
      caseSensitive: false,
      returnValue: 'testValue',
    });

    const plainTextOutput = await caseInsensitive.process({
      input: { type: 'string', value: 'APPROVED' },
    } as Record<PortId, any>);
    assert.equal(plainTextOutput.approved?.value, 'APPROVED');
    assert.match(
      caseInsensitive.getOutputDefinitions().find((output) => output.id === 'unmatched')?.description ?? '',
      /without regard to case/,
    );

    const regex = createNode({
      cases: ['approved'],
      casePortIds: ['approved'],
      matchMode: 'regex',
      caseSensitive: false,
      returnValue: 'testValue',
    });
    const regexOutput = await regex.process({
      input: { type: 'string', value: 'APPROVED' },
    } as Record<PortId, any>);
    assert.equal(regexOutput.approved?.type, 'control-flow-excluded');
    assert.equal(regexOutput.unmatched?.value, 'APPROVED');
  });

  it('defaults an omitted case-sensitivity setting to sensitive Plain text matching', async () => {
    const node = createNode({
      cases: ['approved'],
      casePortIds: ['approved'],
      matchMode: 'plainText',
      caseSensitive: undefined,
      returnValue: 'testValue',
    });

    const output = await node.process({
      input: { type: 'string', value: 'APPROVED' },
    } as Record<PortId, any>);

    assert.equal(output.approved?.type, 'control-flow-excluded');
    assert.equal(output.unmatched?.value, 'APPROVED');
  });

  it('treats omitted settings as Plain text and first-match routing for a persisted Match case node', async () => {
    const node = createNode({
      cases: ['a.b', 'a.b'],
      casePortIds: ['literal', 'second'],
      matchMode: undefined,
      exclusive: undefined,
      returnValue: 'testValue',
    });

    const output = await node.process({
      input: { type: 'string', value: 'axb' },
    } as Record<PortId, any>);

    assert.equal(output.literal?.type, 'control-flow-excluded');
    assert.equal(output.unmatched?.value, 'axb');

    const exact = await node.process({
      input: { type: 'string', value: 'a.b' },
    } as Record<PortId, any>);
    assert.equal(exact.literal?.value, 'a.b');
    assert.equal(exact.second?.type, 'control-flow-excluded');
    assert.equal(node.getBody(), 'Trigger: First matching case');
  });

  it('returns true by default without exposing custom-value inputs', async () => {
    const node = createNode({
      cases: ['same'],
      casePortIds: ['same'],
      returnValue: undefined,
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title }) => ({ id, title })),
      [{ id: 'input', title: 'Input' }],
    );
    assert.match(node.getInputDefinitions()[0]?.description ?? '', /Input/);
    assert.deepEqual(
      node.getOutputDefinitions().map(({ id, dataType }) => ({ id, dataType })),
      [
        { id: 'same', dataType: 'boolean' },
        { id: 'unmatched', dataType: 'boolean' },
      ],
    );

    const matched = await node.process({ input: { type: 'string', value: 'same' } } as Record<PortId, any>);
    assert.deepEqual(matched.same, { type: 'boolean', value: true });
    assert.equal(matched.unmatched?.type, 'control-flow-excluded');

    const unmatched = await node.process({ input: { type: 'string', value: 'other' } } as Record<PortId, any>);
    assert.equal(unmatched.same?.type, 'control-flow-excluded');
    assert.deepEqual(unmatched.unmatched, { type: 'boolean', value: true });
  });

  it('returns the input string without exposing custom-value inputs in Input value mode', async () => {
    const node = createNode({
      cases: ['same'],
      casePortIds: ['same'],
      returnValue: 'testValue',
      valueInputMode: 'per-output',
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title }) => ({ id, title })),
      [{ id: 'input', title: 'Input' }],
    );
    assert.ok(node.getOutputDefinitions().every((output) => output.dataType === 'string'));
    assert.match(node.getOutputDefinitions()[0]?.description ?? '', /Input value/);

    const output = await node.process({ input: { type: 'string', value: 'same' } } as Record<PortId, any>);
    assert.deepEqual(output.same, { type: 'string', value: 'same' });
  });

  it('exposes Return value inputs and retains custom-value routing in Custom mode', async () => {
    const shared = createNode({
      cases: ['same'],
      casePortIds: ['same'],
      returnValue: 'custom',
      valueInputMode: 'shared',
    });
    assert.deepEqual(
      shared.getInputDefinitions().map(({ id, title }) => ({ id, title })),
      [
        { id: 'input', title: 'Input' },
        { id: 'value', title: 'Return value' },
      ],
    );
    assert.ok(shared.getOutputDefinitions().every((output) => output.dataType === 'any'));

    const node = createNode({
      cases: ['same', 'same'],
      casePortIds: ['first', 'second'],
      returnValue: 'custom',
      valueInputMode: 'per-output',
      exclusive: true,
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title }) => ({ id, title })),
      [
        { id: 'input', title: 'Input' },
        { id: 'value-first', title: 'same' },
        { id: 'value-second', title: 'same' },
        { id: 'value-unmatched', title: 'Unmatched' },
      ],
    );

    const output = await node.process({
      input: { type: 'string', value: 'same' },
      'value-first': { type: 'string', value: 'first value' },
      'value-second': { type: 'string', value: 'second value' },
    } as Record<PortId, any>);

    assert.deepEqual(output.first, { type: 'string', value: 'first value' });
    assert.equal(output.second?.type, 'control-flow-excluded');
    assert.equal(output.unmatched?.type, 'control-flow-excluded');
  });
});
