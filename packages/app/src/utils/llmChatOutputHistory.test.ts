import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLLMChatSplitOutputHistoryPresentationData,
  getLLMChatOutputHistoryPageLabel,
  getSelectedLLMChatOutputHistoryData,
  shouldShowLLMChatOutputHistoryPager,
  upsertLLMChatOutputHistoryEntry,
} from './llmChatOutputHistory.js';
import type { PortId } from '@valerypopoff/rivet2-core';
import type { StoredInputsOrOutputs } from '../state/dataFlow.js';

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

test('getSelectedLLMChatOutputHistoryData changes only the displayed output map', () => {
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

test('failed invocations keep completed history pages viewable without terminal outputs', () => {
  const data = upsertLLMChatOutputHistoryEntry(
    { status: { type: 'error', error: 'Tool handler failed' } },
    entry('model-round:0', 'requested tools'),
  ).data;

  const displayed = getSelectedLLMChatOutputHistoryData({ data, selectedPage: 'latest' });

  assert.equal(responseValue(displayed.outputData), 'requested tools');
  assert.deepEqual(displayed.status, { type: 'error', error: 'Tool handler failed' });
  assert.equal(
    shouldShowLLMChatOutputHistoryPager({
      entries: data.llmChatOutputHistory?.[0] ?? [],
      hasTerminalOutput: false,
    }),
    true,
  );
});

test('failed split invocations receive display-only latest output maps for completed rounds', () => {
  const data = upsertLLMChatOutputHistoryEntry(
    { status: { type: 'error', error: 'Tool handler failed' } },
    { ...entry('model-round:0', 'split response'), splitIndex: 2 },
  ).data;

  const displayed = getLLMChatSplitOutputHistoryPresentationData(data);

  assert.equal(responseValue(displayed.splitOutputData?.[2]), 'split response');
  assert.equal(data.splitOutputData, undefined);
});
