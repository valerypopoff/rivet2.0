import assert from 'node:assert/strict';
import test from 'node:test';

import { ManagedWorkflowExecutionCache } from '../routes/workflows/managed/execution-cache.js';

test('workflow-level pointer invalidation removes all cached keys for one workflow only', () => {
  const cache = new ManagedWorkflowExecutionCache({
    endpointPointerLimit: 8,
  });

  cache.setEndpointPointer('published:hello', {
    workflowId: 'workflow-a',
    relativePath: 'hello.rivet-project',
    revisionId: 'revision-1',
  });
  cache.setEndpointPointer('latest:hello', {
    workflowId: 'workflow-a',
    relativePath: 'hello.rivet-project',
    revisionId: 'revision-2',
  });
  cache.setEndpointPointer('published:other', {
    workflowId: 'workflow-b',
    relativePath: 'other.rivet-project',
    revisionId: 'revision-3',
  });

  cache.invalidateWorkflowEndpointPointers('workflow-a');

  assert.equal(cache.getEndpointPointer('published:hello'), null);
  assert.equal(cache.getEndpointPointer('latest:hello'), null);
  assert.deepEqual(cache.getEndpointPointer('published:other'), {
    workflowId: 'workflow-b',
    relativePath: 'other.rivet-project',
    revisionId: 'revision-3',
  });
});

test('endpoint pointers use access-order eviction and keep the reverse index in sync', () => {
  const cache = new ManagedWorkflowExecutionCache({ endpointPointerLimit: 2 });
  const pointer = (workflowId: string, revisionId: string) => ({
    workflowId,
    relativePath: `${workflowId}.rivet-project`,
    revisionId,
  });

  cache.setEndpointPointer('first', pointer('workflow-a', 'revision-1'));
  cache.setEndpointPointer('second', pointer('workflow-a', 'revision-2'));
  assert.equal(cache.getEndpointPointer('first')?.revisionId, 'revision-1');

  cache.setEndpointPointer('third', pointer('workflow-b', 'revision-3'));

  assert.equal(cache.getEndpointPointer('second'), null);
  assert.equal(cache.getEndpointPointer('first')?.revisionId, 'revision-1');
  assert.equal(cache.getEndpointPointer('third')?.revisionId, 'revision-3');

  cache.invalidateWorkflowEndpointPointers('workflow-a');
  assert.equal(cache.getEndpointPointer('first'), null);
  assert.equal(cache.getEndpointPointer('third')?.revisionId, 'revision-3');
});

test('replacing a pointer updates its workflow invalidation ownership', () => {
  const cache = new ManagedWorkflowExecutionCache({ endpointPointerLimit: 2 });

  cache.setEndpointPointer('shared', {
    workflowId: 'workflow-a',
    relativePath: 'a.rivet-project',
    revisionId: 'revision-a',
  });
  cache.setEndpointPointer('shared', {
    workflowId: 'workflow-b',
    relativePath: 'b.rivet-project',
    revisionId: 'revision-b',
  });

  cache.invalidateWorkflowEndpointPointers('workflow-a');
  assert.equal(cache.getEndpointPointer('shared')?.revisionId, 'revision-b');

  cache.invalidateWorkflowEndpointPointers('workflow-b');
  assert.equal(cache.getEndpointPointer('shared'), null);
});

test('revision materialization cache evicts least-recently-used entries by byte budget', () => {
  const cache = new ManagedWorkflowExecutionCache({
    revisionMaterializationBytesLimit: 9,
    maxSingleRevisionBytes: 10,
  });

  cache.setRevisionMaterialization({
    revisionId: 'revision-1',
    contents: '12345',
    datasetsContents: null,
  });
  cache.setRevisionMaterialization({
    revisionId: 'revision-2',
    contents: '67890',
    datasetsContents: null,
  });

  assert.equal(cache.getRevisionMaterialization('revision-1'), null);
  assert.deepEqual(cache.getRevisionMaterialization('revision-2'), {
    revisionId: 'revision-2',
    contents: '67890',
    datasetsContents: null,
  });
});

test('revision materialization cache skips oversized entries', () => {
  const cache = new ManagedWorkflowExecutionCache({
    revisionMaterializationBytesLimit: 32,
    maxSingleRevisionBytes: 4,
  });

  const stored = cache.setRevisionMaterialization({
    revisionId: 'revision-1',
    contents: '12345',
    datasetsContents: null,
  });

  assert.equal(stored, false);
  assert.equal(cache.getRevisionMaterialization('revision-1'), null);
});

test('oversized revision replacement removes an existing cached revision', () => {
  const cache = new ManagedWorkflowExecutionCache({
    revisionMaterializationBytesLimit: 32,
    maxSingleRevisionBytes: 4,
  });

  assert.equal(cache.setRevisionMaterialization({
    revisionId: 'revision-1',
    contents: '1234',
    datasetsContents: null,
  }), true);
  assert.equal(cache.setRevisionMaterialization({
    revisionId: 'revision-1',
    contents: '12345',
    datasetsContents: null,
  }), false);

  assert.equal(cache.getRevisionMaterialization('revision-1'), null);
});
