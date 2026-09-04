import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLLMChatSplitOutputHistoryPresentationData,
  getLLMChatOutputHistoryPageLabel,
  getSelectedLLMChatOutputHistoryData,
  resolveLLMChatOutputHistoryEntry,
  shouldShowLLMChatOutputHistoryPager,
  upsertLLMChatOutputHistoryEntry,
} from './llmChatOutputHistory.js';
import type { PortId } from '@valerypopoff/rivet2-core';
import type { NodeRunDataWithRefs, StoredInputsOrOutputs } from '../state/dataFlow.js';

const responsePortId = 'response' as PortId;

function responseOutput(response: string): StoredInputsOrOutputs {
  return {
    [responsePortId]: { type: 'string', storage: 'inline', value: response },
  };
}

function responseValue(data: StoredInputsOrOutputs | undefined): string | undefined {
  const value = data?.[responsePortId];
  return value?.type === 'string' && value.storage === 'inline' ? value.value : undefined;
}

function refResponseOutput(refId: string): StoredInputsOrOutputs {
  return {
    [responsePortId]: {
      type: 'string',
      storage: 'ref',
      refId,
      preview: { kind: 'text', excerpt: 'response', totalChars: 8, lineCount: 1 },
    },
  };
}

function entry(entryId: string, response: string, roundIndex = 0) {
  return {
    entryId,
    kind: 'model-round' as const,
    outcome: entryId === 'model-round:0' ? ('tool-calls' as const) : ('final-answer' as const),
    roundIndex,
    splitIndex: 0,
    outputData: responseOutput(response),
  };
}

test('upsertLLMChatOutputHistoryEntry keeps logical-round order and replaces duplicate delivery in place', () => {
  const initial = {
    outputData: responseOutput('terminal'),
  };
  const first = upsertLLMChatOutputHistoryEntry(initial, entry('model-round:0', 'requested tools'));
  const second = upsertLLMChatOutputHistoryEntry(first.data, entry('model-round:1', 'final answer', 1));
  const redelivered = upsertLLMChatOutputHistoryEntry(second.data, entry('model-round:0', 'updated tools'));

  assert.deepEqual(
    redelivered.data.llmChatOutputHistory?.[0]?.map((candidate) => [candidate.entryId, responseValue(candidate.outputData)]),
    [
      ['model-round:0', 'updated tools'],
      ['model-round:1', 'final answer'],
    ],
  );
  assert.deepEqual(redelivered.replacedRefIds, []);
  assert.equal(responseValue(redelivered.data.outputData), 'terminal');
});

test('upsertLLMChatOutputHistoryEntry keeps refs reused by a redelivered snapshot', () => {
  const first = upsertLLMChatOutputHistoryEntry(
    {},
    { ...entry('model-round:0', 'ignored'), outputData: refResponseOutput('history:round:0:response') },
  );
  const redelivered = upsertLLMChatOutputHistoryEntry(
    first.data,
    { ...entry('model-round:0', 'ignored'), outputData: refResponseOutput('history:round:0:response') },
  );
  const replacement = upsertLLMChatOutputHistoryEntry(
    redelivered.data,
    { ...entry('model-round:0', 'ignored'), outputData: refResponseOutput('history:round:0:replacement') },
  );

  assert.deepEqual(redelivered.replacedRefIds, []);
  assert.deepEqual(replacement.replacedRefIds, ['history:round:0:response']);
});

test('getSelectedLLMChatOutputHistoryData changes the displayed output map without changing terminal output data', () => {
  const data = upsertLLMChatOutputHistoryEntry(
    {
      outputData: responseOutput('terminal response'),
      splitOutputData: {
        0: responseOutput('split terminal'),
      },
    },
    entry('model-round:0', 'requested tools'),
  ).data;

  const historical = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'model-round:0' });
  const latest = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'latest' });

  assert.equal(responseValue(historical.outputData), 'requested tools');
  assert.equal(historical.splitOutputData, undefined);
  assert.equal(responseValue(data.outputData), 'terminal response');
  assert.equal(latest, data);
});

test('labels direct results and logical model rounds distinctly', () => {
  assert.equal(getLLMChatOutputHistoryPageLabel(entry('model-round:0', 'tools')), 'Round 1 · Requested tools');
  assert.equal(
    getLLMChatOutputHistoryPageLabel({
      ...entry('direct-tool-result:0', 'export'),
      kind: 'direct-tool-result',
      outcome: 'direct-tool-result',
    }),
    'Direct tool result',
  );
});

test('failed invocations show a terminal error only on the newest retained history page', () => {
  const failedStatus = { type: 'error', error: 'Tool handler failed' } as const;
  let data: NodeRunDataWithRefs = { status: failedStatus };
  for (const [roundIndex, response] of ['first tools', 'second tools', 'third tools'].entries()) {
    data = upsertLLMChatOutputHistoryEntry(data, {
      ...entry(`model-round:${roundIndex}`, response, roundIndex),
      outcome: 'tool-calls',
    }).data;
  }

  const first = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'model-round:0' });
  const second = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'model-round:1' });
  const third = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'model-round:2' });
  const latest = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'latest' });

  assert.equal(responseValue(first.outputData), 'first tools');
  assert.equal(responseValue(second.outputData), 'second tools');
  assert.equal(responseValue(third.outputData), 'third tools');
  assert.equal(responseValue(latest.outputData), 'third tools');
  assert.equal(first.status, undefined);
  assert.equal(second.status, undefined);
  assert.deepEqual(third.status, failedStatus);
  assert.deepEqual(latest.status, failedStatus);
  assert.equal(
    shouldShowLLMChatOutputHistoryPager({
      entries: data.llmChatOutputHistory?.[0] ?? [],
      hasTerminalOutput: false,
    }),
    true,
  );
});

test('the final visible round keeps its terminal error through either page identifier', () => {
  const failedStatus = { type: 'error', error: 'Terminal projection failed' } as const;
  const data = upsertLLMChatOutputHistoryEntry(
    upsertLLMChatOutputHistoryEntry(
      { outputData: responseOutput('terminal response'), status: failedStatus },
      entry('model-round:0', 'first tools'),
    ).data,
    entry('model-round:1', 'second tools', 1),
  ).data;

  const first = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'model-round:0' });
  const second = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'model-round:1' });
  const latest = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'latest' });

  assert.equal(responseValue(first.outputData), 'first tools');
  assert.equal(responseValue(second.outputData), 'second tools');
  assert.equal(responseValue(latest.outputData), 'terminal response');
  assert.equal(first.status, undefined);
  assert.deepEqual(second.status, failedStatus);
  assert.deepEqual(latest.status, failedStatus);
});

test('a stale historical-page selection resolves to the newest retained round', () => {
  const entries = [entry('model-round:0', 'first tools'), entry('model-round:1', 'second tools', 1)];
  const selected = resolveLLMChatOutputHistoryEntry(entries, 'model-round:missing');

  assert.equal(selected?.entryId, 'model-round:1');
});

test('failed split invocations receive display-only latest output maps for completed rounds', () => {
  const data = upsertLLMChatOutputHistoryEntry(
    { status: { type: 'error', error: 'Tool handler failed' } },
    { ...entry('model-round:0', 'split response'), splitIndex: 2 },
  ).data;

  const displayed = getLLMChatSplitOutputHistoryPresentationData(data, true);

  assert.equal(responseValue(displayed.splitOutputData?.[2]), 'split response');
  assert.equal(data.splitOutputData, undefined);
});

test('ordinary failed multi-round invocations do not synthesize split output', () => {
  const data = upsertLLMChatOutputHistoryEntry(
    { status: { type: 'error', error: 'Tool handler failed' } },
    entry('model-round:0', 'requested tools'),
  ).data;

  const displayed = getLLMChatSplitOutputHistoryPresentationData(data, false);

  assert.equal(displayed, data);
  assert.equal(displayed.splitOutputData, undefined);
});
