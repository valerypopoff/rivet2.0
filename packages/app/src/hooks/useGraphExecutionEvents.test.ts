import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, GraphRunId, RootRunId } from '@valerypopoff/rivet2-core';
import type { GraphViewKey } from '../domain/graphEditing/navigationActions';
import {
  removeRunningGraphEntry,
  updateSelectedGraphRunForGraphStart,
  startGraphRunHistory,
  finishGraphRunHistory,
} from './graphExecutionEventHelpers';

test('shared graph history keeps invocation identity, ignores duplicate starts and never fabricates legacy runs', () => {
  const view = 'root:graph-a' as GraphViewKey;
  const execution = { graphId: 'graph-a' as GraphId, graphRunId: 'run' as GraphRunId, rootRunId: 'root' as RootRunId };
  const history = startGraphRunHistory({}, view, execution);
  assert.equal(startGraphRunHistory(history, view, execution), history);
  assert.equal(startGraphRunHistory(history, view, undefined), history);
  assert.equal(finishGraphRunHistory(history, view, undefined, 'ok'), history);
  assert.equal(finishGraphRunHistory(history, view, 'missing' as GraphRunId, 'ok'), history);
  const terminal = finishGraphRunHistory(history, view, execution.graphRunId, 'aborted');
  assert.equal(terminal[view]![0]!.status, 'aborted');
  assert.equal(terminal[view]![0]!.rootRunId, execution.rootRunId);
  assert.equal(history[view]![0]!.status, 'running');
});

test('updateSelectedGraphRunForGraphStart preserves explicit historical selection', () => {
  assert.deepEqual(
    updateSelectedGraphRunForGraphStart(
      {
        'root:graph-a': 'graph-run-1' as GraphRunId,
        'root:graph-b': 'latest',
      },
      'root:graph-a' as GraphViewKey,
    ),
    {
      'root:graph-a': 'graph-run-1' as GraphRunId,
      'root:graph-b': 'latest',
    },
  );
});

test('updateSelectedGraphRunForGraphStart follows latest when unset or already latest', () => {
  assert.deepEqual(updateSelectedGraphRunForGraphStart({}, 'root:graph-a' as GraphViewKey), {
    'root:graph-a': 'latest',
  });
  assert.deepEqual(
    updateSelectedGraphRunForGraphStart(
      {
        'root:graph-a': 'latest',
      },
      'root:graph-a' as GraphViewKey,
    ),
    {
      'root:graph-a': 'latest',
    },
  );
});

test('removeRunningGraphEntry removes only one matching running graph occurrence', () => {
  assert.deepEqual(
    removeRunningGraphEntry(['graph-a' as GraphId, 'graph-b' as GraphId, 'graph-a' as GraphId], 'graph-a' as GraphId),
    ['graph-b' as GraphId, 'graph-a' as GraphId],
  );
  assert.deepEqual(removeRunningGraphEntry(['graph-a' as GraphId, 'graph-b' as GraphId], 'graph-c' as GraphId), [
    'graph-a' as GraphId,
    'graph-b' as GraphId,
  ]);
});
