import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, GraphRunId, NodeId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';
import { filterRunActivityItems } from './filterRunActivityItems.js';
import type { RunActivityItemViewModel } from './types.js';

const ITEMS: RunActivityItemViewModel[] = [
  item('model', 1, 'main', 'Main graph', 'Answer User Request', 'LLM Chat', 'model'),
  {
    ...item('tool', 2, 'tools', 'Tool handlers', 'Search docs', 'Delegate Tool Call', 'tool'),
    toolName: 'searchKnowledge',
  },
  {
    ...item('error', 3, 'tools', 'Tool handlers', 'Fetch URL', 'HTTP Call', 'generic'),
    status: 'error',
    error: 'Request failed',
  },
];

test('matches node-title terms case-insensitively while retaining metadata filters', () => {
  assert.deepEqual(
    filterRunActivityItems(ITEMS, { filter: 'all', graphId: '', query: 'USER answer' }).map(
      (entry) => entry.activityKey,
    ),
    ['model'],
  );
  assert.deepEqual(
    filterRunActivityItems(ITEMS, { filter: 'llm-tools', graphId: 'tools', query: 'knowledge' }).map(
      (entry) => entry.activityKey,
    ),
    ['tool'],
  );
  assert.deepEqual(
    filterRunActivityItems(ITEMS, { filter: 'errors', graphId: '', query: '' }).map((entry) => entry.activityKey),
    ['error'],
  );
});

function item(
  key: string,
  sequence: number,
  graphId: string,
  graphName: string,
  nodeTitle: string,
  nodeType: string,
  category: RunActivityItemViewModel['category'],
): RunActivityItemViewModel {
  return {
    activityKey: key,
    identity: {
      rootRunId: 'root' as RootRunId,
      graphRunId: `${graphId}-run` as GraphRunId,
      graphId: graphId as GraphId,
      nodeId: key as NodeId,
      processId: `${key}-process` as ProcessId,
    },
    sequence,
    graphId: graphId as GraphId,
    graphName,
    nodeTitle,
    nodeType,
    status: 'success',
    category,
    resultOrigin: 'executed',
  };
}
