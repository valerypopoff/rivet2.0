import type { GraphId } from '@valerypopoff/rivet2-core';
import {
  graphBuilderAuthorizationScopeSchema,
  type GraphBuilderAuthorizationScope,
  type GraphPatchOperation,
} from './graphBuilderSchemas.js';
import { parsePortableJson } from './portableJson.js';

export type GraphBuilderAuthorizationFailure = {
  code: 'active-graph-not-authorized' | 'operation-not-authorized' | 'cross-graph-propagation-not-authorized';
  operationIndex?: number;
  message: string;
};

export function parseGraphBuilderAuthorizationScope(value: unknown): GraphBuilderAuthorizationScope {
  return graphBuilderAuthorizationScopeSchema.parse(parsePortableJson(value));
}

export function authorizeGraphBuilderOperations(input: {
  activeGraphId: GraphId;
  operations: readonly GraphPatchOperation[];
  scope: GraphBuilderAuthorizationScope;
  requiresSemanticCrossGraphPropagation?: boolean;
}): GraphBuilderAuthorizationFailure[] {
  const failures: GraphBuilderAuthorizationFailure[] = [];

  if (!input.scope.allowedGraphIds.includes(input.activeGraphId)) {
    failures.push({
      code: 'active-graph-not-authorized',
      message: `Graph "${input.activeGraphId}" is outside the Graph Builder authorization scope.`,
    });
  }

  if (input.requiresSemanticCrossGraphPropagation && !input.scope.allowSemanticCrossGraphPropagation) {
    failures.push({
      code: 'cross-graph-propagation-not-authorized',
      message: 'This operation requires semantic cross-graph propagation, which is not authorized.',
    });
  }

  input.operations.forEach((operation, operationIndex) => {
    if (!input.scope.allowedOperations.includes(operation.op)) {
      failures.push({
        code: 'operation-not-authorized',
        operationIndex,
        message: `Operation "${operation.op}" is outside the Graph Builder authorization scope.`,
      });
    }
  });

  return failures;
}
