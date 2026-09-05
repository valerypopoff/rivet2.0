import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeId, PortId, ProcessId } from '@valerypopoff/rivet2-core';
import type { NodeRunDataWithRefs } from '../state/dataFlow.js';
import {
  mergeNodeRunDataForProcess,
  prepareNodeRunDataForStorage,
  removeUserInputQuestionsForProcess,
} from './useExecutionDataFlow.js';

test('terminal prompt removal preserves other nodes and removes empty entries without mutating state', () => {
  const nodeId = 'finished-node' as NodeId;
  const otherNodeId = 'waiting-node' as NodeId;
  const processId = 'finished-process' as ProcessId;
  const questions = {
    [nodeId]: [{ nodeId, processId, questions: ['Finished?'] }],
    [otherNodeId]: [{ nodeId: otherNodeId, processId: 'waiting-process' as ProcessId, questions: ['Waiting?'] }],
  };
  const next = removeUserInputQuestionsForProcess(questions, nodeId, processId);
  assert.equal(Object.hasOwn(next, nodeId), false);
  assert.equal(next[otherNodeId], questions[otherNodeId]);
  assert.equal(questions[nodeId]!.length, 1);
  assert.equal(removeUserInputQuestionsForProcess(next, nodeId, processId), next);
  assert.equal(removeUserInputQuestionsForProcess(questions, otherNodeId, processId), questions);
});

test('prepareNodeRunDataForStorage drops malformed output fields from running updates', () => {
  const preparedData = prepareNodeRunDataForStorage({
    inputData: {},
    outputData: {
      ['output' as PortId]: {
        type: 'string',
        value: 'not final',
      },
    },
    splitOutputData: {
      0: {},
    },
    status: { type: 'running' },
  });

  assert.deepEqual(preparedData, {
    inputData: {},
    status: { type: 'running' },
  });
});

test('mergeNodeRunDataForProcess does not let stale nodeStart regress a terminal process', () => {
  const previousData: NodeRunDataWithRefs = {
    durationMs: 12,
    finishedAt: 200,
    outputData: {
      ['output' as PortId]: {
        storage: 'inline',
        type: 'string',
        value: 'done',
      },
    },
    status: { type: 'ok' },
    startedAt: 100,
  };

  const mergedData = mergeNodeRunDataForProcess(previousData, {
    inputData: {
      ['input' as PortId]: {
        storage: 'inline',
        type: 'string',
        value: 'start',
      },
    },
    startedAt: 300,
    status: { type: 'running' },
  });

  assert.deepEqual(mergedData, {
    ...previousData,
    inputData: {
      ['input' as PortId]: {
        storage: 'inline',
        type: 'string',
        value: 'start',
      },
    },
    startedAt: 100,
  });
});

test('mergeNodeRunDataForProcess does not let stale running data replace terminal outputs', () => {
  const previousData: NodeRunDataWithRefs = {
    outputData: {
      ['output' as PortId]: {
        storage: 'inline',
        type: 'string',
        value: 'final',
      },
    },
    status: { type: 'ok' },
  };

  const mergedData = mergeNodeRunDataForProcess(previousData, {
    outputData: {},
    status: { type: 'running' },
  });

  assert.deepEqual(mergedData, previousData);
});

test('mergeNodeRunDataForProcess removes stale startedAt when terminal process has no start timestamp', () => {
  const previousData: NodeRunDataWithRefs = {
    finishedAt: 200,
    status: { type: 'ok' },
  };

  const mergedData = mergeNodeRunDataForProcess(previousData, {
    startedAt: 300,
    status: { type: 'running' },
  });

  assert.deepEqual(mergedData, previousData);
});

test('mergeNodeRunDataForProcess still applies normal terminal updates', () => {
  const mergedData = mergeNodeRunDataForProcess(
    {
      inputData: {},
      startedAt: 100,
      status: { type: 'running' },
    },
    {
      durationMs: 7,
      finishedAt: 110,
      outputData: {},
      status: { type: 'ok' },
    },
  );

  assert.deepEqual(mergedData, {
    inputData: {},
    startedAt: 100,
    durationMs: 7,
    finishedAt: 110,
    outputData: {},
    status: { type: 'ok' },
  });
});
