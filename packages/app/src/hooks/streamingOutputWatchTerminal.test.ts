import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GraphId,
  type GraphRunId,
  type NodeId,
  type ProcessEvents,
  type ProcessId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import type { RunDataByNodeId } from '../state/dataFlow.js';
import { markStreamingOutputWatchTerminal } from './streamingOutputWatchTerminal.js';

test('marks only the selected Watch child run in the summary root', () => {
  const rootRunId = 'watch-root' as RootRunId;
  const selectedGraphRunId = 'selected-child' as GraphRunId;
  const data: RunDataByNodeId = {
    ['first' as NodeId]: [
      {
        data: {},
        graphRunId: 'first-child' as GraphRunId,
        processId: 'first-process' as ProcessId,
        rootRunId,
      },
    ],
    ['selected' as NodeId]: [
      {
        data: {},
        graphRunId: selectedGraphRunId,
        processId: 'selected-process' as ProcessId,
        rootRunId,
      },
    ],
    ['late-parallel' as NodeId]: [
      {
        data: {},
        graphRunId: 'late-child' as GraphRunId,
        processId: 'late-process' as ProcessId,
        rootRunId,
      },
    ],
    ['another-root' as NodeId]: [
      {
        data: {},
        graphRunId: selectedGraphRunId,
        processId: 'other-root-process' as ProcessId,
        rootRunId: 'another-root' as RootRunId,
      },
    ],
  };
  const summaryEvent = {
    execution: {
      graphId: 'owner-graph' as GraphId,
      graphRunId: 'owner-run' as GraphRunId,
      rootRunId,
    },
    summary: {
      cancelledIterations: 0,
      coalescedUpdates: 0,
      completedIterations: 4,
      droppedUpdates: 0,
      failedIterations: 0,
      maximumQueuedUpdates: 2,
      omittedIterations: 0,
      receivedUpdates: 4,
      retainedIterationUpdateIndexes: [1, 2, 3, 4],
      selectedIteration: { graphRunId: selectedGraphRunId, reason: 'stop' as const, updateIndex: 2 },
    },
    watchNode: { id: 'watch-node' as NodeId, type: 'watchStreamingOutput' },
  } as ProcessEvents['streamingOutputWatchSummary'];

  assert.equal(markStreamingOutputWatchTerminal(data, summaryEvent), true);
  assert.equal(data['first' as NodeId]?.[0]?.data.streamingWatchTerminal, undefined);
  assert.equal(data['selected' as NodeId]?.[0]?.data.streamingWatchTerminal, true);
  assert.equal(data['late-parallel' as NodeId]?.[0]?.data.streamingWatchTerminal, undefined);
  assert.equal(data['another-root' as NodeId]?.[0]?.data.streamingWatchTerminal, undefined);

  // A duplicate transport/replay summary is harmless and does not cause an
  // unnecessary state publication.
  assert.equal(markStreamingOutputWatchTerminal(data, summaryEvent), false);
});

test('does not guess a terminal page for legacy summaries without child identity', () => {
  const nodeId = 'node' as NodeId;
  const data: RunDataByNodeId = {
    [nodeId]: [{ data: {}, processId: 'process' as ProcessId }],
  };

  assert.equal(
    markStreamingOutputWatchTerminal(data, {
      execution: {
        graphId: 'owner-graph' as GraphId,
        graphRunId: 'owner-run' as GraphRunId,
        rootRunId: 'root' as RootRunId,
      },
      summary: {
        cancelledIterations: 0,
        coalescedUpdates: 0,
        completedIterations: 1,
        droppedUpdates: 0,
        failedIterations: 0,
        maximumQueuedUpdates: 1,
        omittedIterations: 0,
        receivedUpdates: 1,
        retainedIterationUpdateIndexes: [1],
        selectedIteration: { reason: 'latest', updateIndex: 1 },
      },
      watchNode: { id: 'watch-node' as NodeId, type: 'watchStreamingOutput' },
    } as ProcessEvents['streamingOutputWatchSummary']),
    false,
  );
  assert.equal(data[nodeId]?.[0]?.data.streamingWatchTerminal, undefined);
});
