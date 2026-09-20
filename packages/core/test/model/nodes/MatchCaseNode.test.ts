import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MatchCaseNodeImpl,
  matchCaseNode,
  type InternalProcessContext,
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
    assert.equal(modeEditor?.layout, 'inline');
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
    assert.equal(sensitivityEditor?.layout, 'inline');
    assert.equal(sensitivityEditor?.hideIf?.({ ...node.data, matchMode: 'regex' }), true);
    assert.equal(sensitivityEditor?.hideIf?.({ ...node.data, matchMode: 'plainText' }), false);

    const casesEditor = new MatchCaseNodeImpl(node)
      .getEditors()
      .find((editor) => editor.type === 'stringList' && editor.dataKey === 'cases');
    assert.equal(casesEditor?.helperMessage, undefined);
    assert.equal(casesEditor?.boxed, true);

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

  it('creates one interpolation input per case-template variable without creating ports for runtime roots', () => {
    const node = createNode({
      cases: ['{{expected}}', 'status: {{response.status}}', '{{expected | uppercase}}', '{{@context.tenant}}'],
      casePortIds: ['expected', 'status', 'again', 'tenant'],
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title, dataType, data }) => ({ id, title, dataType, data })),
      [
        { id: 'input', title: 'Input', dataType: 'string', data: undefined },
        {
          id: 'input-expected',
          title: 'expected',
          dataType: 'string',
          data: { kind: 'interpolation-input', interpolationName: 'expected' },
        },
        {
          id: 'input-response',
          title: 'response',
          dataType: 'any',
          data: { kind: 'interpolation-input', interpolationName: 'response' },
        },
      ],
    );
  });

  it('interpolates Plain text cases with variables, JSONPath, and text processors before matching', async () => {
    const node = createNode({
      cases: ['{{expected}}', 'status: {{response.status | uppercase}}'],
      casePortIds: ['expected', 'status'],
      returnValue: 'testValue',
    });

    const expected = await node.process({
      input: { type: 'string', value: 'approved' },
      'input-expected': { type: 'string', value: 'approved' },
      'input-response': { type: 'object', value: { status: 'rejected' } },
    } as Record<PortId, any>);
    assert.equal(expected.expected?.value, 'approved');
    assert.equal(expected.status?.type, 'control-flow-excluded');

    const nested = await node.process({
      input: { type: 'string', value: 'status: REJECTED' },
      'input-expected': { type: 'string', value: 'approved' },
      'input-response': { type: 'object', value: { status: 'rejected' } },
    } as Record<PortId, any>);
    assert.equal(nested.expected?.type, 'control-flow-excluded');
    assert.equal(nested.status?.value, 'status: REJECTED');
  });

  it('keeps escaped and inserted interpolation-looking text on the shared template semantics', async () => {
    const node = createNode({
      cases: ['{{{literal}}}', '{{template}}'],
      casePortIds: ['literal', 'template'],
      returnValue: 'testValue',
      exclusive: false,
    });

    const escaped = await node.process({
      input: { type: 'string', value: '{{literal}}' },
      'input-template': { type: 'string', value: '{{other}}' },
    } as Record<PortId, any>);
    assert.equal(escaped.literal?.value, '{{literal}}');
    assert.equal(escaped.template?.type, 'control-flow-excluded');

    const inserted = await node.process({
      input: { type: 'string', value: '{{other}}' },
      'input-template': { type: 'string', value: '{{other}}' },
    } as Record<PortId, any>);
    assert.equal(inserted.literal?.type, 'control-flow-excluded');
    assert.equal(inserted.template?.value, '{{other}}');
  });

  it('resolves graph, context, and global runtime roots without exposing extra inputs', async () => {
    const node = createNode({
      cases: ['{{@graphInputs.status}}', '{{@context.tenant}}', '{{@globals.environment}}'],
      casePortIds: ['graph', 'context', 'global'],
      returnValue: 'testValue',
      exclusive: false,
    });
    let globalReads = 0;
    const context = {
      graphInputNodeValues: { status: { type: 'string', value: 'graph-value' } },
      contextValues: { tenant: { type: 'string', value: 'context-value' } },
      getGlobal(id: string) {
        globalReads += 1;
        return id === 'environment' ? 'global-value' : undefined;
      },
    } as InternalProcessContext;

    const graphOutput = await node.process({ input: { type: 'string', value: 'graph-value' } } as Record<PortId, any>, context);
    assert.equal(graphOutput.graph?.value, 'graph-value');
    assert.equal(graphOutput.context?.type, 'control-flow-excluded');
    assert.equal(graphOutput.global?.type, 'control-flow-excluded');

    const contextOutput = await node.process(
      { input: { type: 'string', value: 'context-value' } } as Record<PortId, any>,
      context,
    );
    assert.equal(contextOutput.graph?.type, 'control-flow-excluded');
    assert.equal(contextOutput.context?.value, 'context-value');
    assert.equal(contextOutput.global?.type, 'control-flow-excluded');

    const globalOutput = await node.process(
      { input: { type: 'string', value: 'global-value' } } as Record<PortId, any>,
      context,
    );
    assert.equal(globalOutput.graph?.type, 'control-flow-excluded');
    assert.equal(globalOutput.context?.type, 'control-flow-excluded');
    assert.equal(globalOutput.global?.value, 'global-value');
    assert.equal(globalReads, 3);
    assert.deepEqual(node.getInputDefinitions().map(({ id }) => id), ['input']);
  });

  it('snapshots a repeated global once while resolving every case row', async () => {
    const node = createNode({
      cases: ['{{@globals.environment}}', 'prefix {{@globals.environment}}'],
      casePortIds: ['exact', 'prefixed'],
      returnValue: 'testValue',
      exclusive: false,
    });
    let globalReads = 0;
    const context = {
      getGlobal(id: string) {
        globalReads += 1;
        return id === 'environment' ? 'production' : undefined;
      },
    } as InternalProcessContext;

    const output = await node.process(
      { input: { type: 'string', value: 'production' } } as Record<PortId, any>,
      context,
    );

    assert.equal(output.exact?.value, 'production');
    assert.equal(output.prefixed?.type, 'control-flow-excluded');
    assert.equal(globalReads, 1);
  });

  it('interpolates Regular expression cases before compiling them', async () => {
    const node = createNode({
      cases: ['^{{prefix}}_[0-9]+$'],
      casePortIds: ['pattern'],
      matchMode: 'regex',
      returnValue: 'testValue',
    });

    const output = await node.process({
      input: { type: 'string', value: 'ERR_42' },
      'input-prefix': { type: 'string', value: 'ERR' },
    } as Record<PortId, any>);
    assert.equal(output.pattern?.value, 'ERR_42');

    const invalid = createNode({
      cases: ['{{pattern}}'],
      casePortIds: ['pattern'],
      matchMode: 'regex',
    });
    await assert.rejects(
      invalid.process({
        input: { type: 'string', value: 'anything' },
        'input-pattern': { type: 'string', value: '[' },
      } as Record<PortId, any>),
      SyntaxError,
    );
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

  it('exposes Output value inputs and retains custom-value routing in Custom mode', async () => {
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
        { id: 'value', title: 'Output value' },
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
