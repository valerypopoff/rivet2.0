import assert from 'node:assert/strict';
import test from 'node:test';
import type { RootRunId } from '@valerypopoff/rivet2-core';
import { createRunActivityJournal } from '../features/runActivity/runActivityJournal.js';
import { resolveRuntimeStatusTiming } from './runtimeStatus.js';

test('uses the exact finished Run Activity duration after the compact status remounts', () => {
  const journal = createRunActivityJournal();
  const rootRunId = 'completed-root' as RootRunId;
  journal.rootsById[rootRunId] = {
    sequence: 1,
    rootRunId,
    status: 'completed',
    startedAt: 1_000,
    finishedAt: 3_750,
    paused: false,
    isPartial: false,
    graphRunsById: {},
    graphRunOrder: [],
    nodeInvocationsByKey: {},
    nodeInvocationOrder: [],
    omittedNodeInvocationCount: 0,
    omittedLegacyEventCount: 0,
  };
  journal.rootOrder = [rootRunId];
  journal.latestCompletedRootRunId = rootRunId;

  assert.deepEqual(
    resolveRuntimeStatusTiming({
      graphRunning: false,
      graphStartTime: 1_000,
      journal,
      now: 99_000,
    }),
    { elapsedMs: 2_750, startedAt: 1_000, isLive: false },
  );
});

test('uses graph start as a live fallback before an identified activity root arrives', () => {
  assert.deepEqual(
    resolveRuntimeStatusTiming({
      graphRunning: true,
      graphStartTime: 2_000,
      journal: createRunActivityJournal(),
      now: 2_125,
    }),
    { elapsedMs: 125, startedAt: 2_000, isLive: true },
  );
});

test('does not let the previous completed root mask a newly starting live run', () => {
  const journal = createRunActivityJournal();
  const previousRootRunId = 'previous-root' as RootRunId;
  journal.rootsById[previousRootRunId] = {
    sequence: 1,
    rootRunId: previousRootRunId,
    status: 'completed',
    startedAt: 1_000,
    finishedAt: 2_000,
    paused: false,
    isPartial: false,
    graphRunsById: {},
    graphRunOrder: [],
    nodeInvocationsByKey: {},
    nodeInvocationOrder: [],
    omittedNodeInvocationCount: 0,
    omittedLegacyEventCount: 0,
  };
  journal.rootOrder = [previousRootRunId];
  journal.latestCompletedRootRunId = previousRootRunId;

  assert.deepEqual(
    resolveRuntimeStatusTiming({
      graphRunning: true,
      graphStartTime: 10_000,
      journal,
      now: 10_250,
    }),
    { elapsedMs: 250, startedAt: 10_000, isLive: true },
  );
});

test('does not turn a retained legacy start time into an ever-growing completed duration', () => {
  assert.deepEqual(
    resolveRuntimeStatusTiming({
      graphRunning: false,
      graphStartTime: 2_000,
      journal: createRunActivityJournal(),
      now: 20_000,
    }),
    { isLive: false },
  );
});
