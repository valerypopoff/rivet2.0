import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId } from '@valerypopoff/rivet2-core';
import { authorizeGraphBuilderOperations, parseGraphBuilderAuthorizationScope } from './index.js';

test('authorization is explicit for the active graph and every operation', () => {
  const scope = parseGraphBuilderAuthorizationScope({
    allowedGraphIds: ['graph-a'],
    allowedOperations: ['createNode'],
    allowSemanticCrossGraphPropagation: false,
    sensitiveFieldAccess: 'none',
  });

  assert.deepEqual(
    authorizeGraphBuilderOperations({
      activeGraphId: 'graph-b' as GraphId,
      operations: [
        {
          op: 'deleteNode',
          node: { kind: 'existing', nodeId: 'node-a' },
        },
      ],
      scope,
      requiresSemanticCrossGraphPropagation: true,
    }).map((failure) => failure.code),
    ['active-graph-not-authorized', 'cross-graph-propagation-not-authorized', 'operation-not-authorized'],
  );
});

test('cloneNode is authorized only when explicitly included in the operation scope', () => {
  const cloneOperation = {
    op: 'cloneNode' as const,
    clientId: 'copy',
    source: { kind: 'existing' as const, nodeId: 'source' },
  };
  const allowedScope = parseGraphBuilderAuthorizationScope({
    allowedGraphIds: ['graph-a'],
    allowedOperations: ['cloneNode'],
    allowSemanticCrossGraphPropagation: false,
    sensitiveFieldAccess: 'none',
  });

  assert.deepEqual(
    authorizeGraphBuilderOperations({
      activeGraphId: 'graph-a' as GraphId,
      operations: [cloneOperation],
      scope: allowedScope,
    }),
    [],
  );

  const createOnlyScope = parseGraphBuilderAuthorizationScope({
    allowedGraphIds: ['graph-a'],
    allowedOperations: ['createNode'],
    allowSemanticCrossGraphPropagation: false,
    sensitiveFieldAccess: 'none',
  });
  assert.deepEqual(
    authorizeGraphBuilderOperations({
      activeGraphId: 'graph-a' as GraphId,
      operations: [cloneOperation],
      scope: createOnlyScope,
    }).map(({ code, operationIndex }) => ({ code, operationIndex })),
    [{ code: 'operation-not-authorized', operationIndex: 0 }],
  );
});
