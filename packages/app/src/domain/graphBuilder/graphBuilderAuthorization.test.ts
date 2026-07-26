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
