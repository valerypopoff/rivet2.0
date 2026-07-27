import { z } from 'zod';
import { canonicalGraphBuilderStringify } from './canonicalGraphBuilderValue.js';
import {
  GRAPH_BUILDER_DANGEROUS_KEYS,
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
} from './graphBuilderLimits.js';
import {
  GraphBuilderUnifiedDiffError,
  isNormalizedGraphBuilderVirtualDocumentPath,
  parseGraphBuilderUnifiedDiff,
} from './graphBuilderUnifiedDiff.js';
import { parsePortableJson, type PortableJsonObject, type PortableJsonValue } from './portableJson.js';

const boundedIdentifierSchema = z
  .string()
  .min(1)
  .max(GRAPH_BUILDER_LIMITS.maxIdentifierLength)
  .refine((value) => value.trim() === value, 'Identifier must not have surrounding whitespace');

const safeDictionaryKeySchema = boundedIdentifierSchema.refine(
  (value) => !GRAPH_BUILDER_DANGEROUS_KEYS.has(value),
  'Dangerous dictionary keys are not allowed as model-controlled identifiers',
);

const boundedTextSchema = (maximumLength: number) => z.string().min(1).max(maximumLength);

const virtualDocumentPathSchema = z
  .string()
  .min(1)
  .max(GRAPH_BUILDER_LIMITS.maxSettingPathLength)
  .refine((value) => value.trim() === value, 'Virtual document paths must not have surrounding whitespace')
  .refine(isNormalizedGraphBuilderVirtualDocumentPath, 'Virtual document paths must be normalized relative paths');

function validateStandardUnifiedDiff(value: string, context: z.RefinementCtx): void {
  try {
    parseGraphBuilderUnifiedDiff(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof GraphBuilderUnifiedDiffError ? error.message : 'Unified diff could not be validated.',
    });
  }
}

const graphBuilderUnifiedDiffSchema = z
  .string()
  .min(1)
  .max(GRAPH_BUILDER_LIMITS.maxPortableBytes)
  .superRefine(validateStandardUnifiedDiff);

function uniqueStringArraySchema<T extends z.ZodType<string>>(
  itemSchema: T,
  limits: { min: number; max: number; fieldName: string },
) {
  return z
    .array(itemSchema)
    .min(limits.min)
    .max(limits.max)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: 'custom',
            message: `${limits.fieldName} must not contain duplicate values`,
            path: [index],
          });
        }
        seen.add(value);
      });
    });
}

const portableJsonObjectSchema: z.ZodType<PortableJsonObject> = z.lazy(() =>
  z
    .record(z.string().max(GRAPH_BUILDER_LIMITS.maxStringLength), portableJsonValueSchema)
    .superRefine((value, context) => {
      const keys = Object.keys(value);
      if (keys.length > GRAPH_BUILDER_LIMITS.maxDictionaryEntries) {
        context.addIssue({
          code: 'custom',
          message: `Object exceeds the ${GRAPH_BUILDER_LIMITS.maxDictionaryEntries}-property limit`,
        });
      }
      for (const key of keys) {
        if (GRAPH_BUILDER_DANGEROUS_KEYS.has(key)) {
          context.addIssue({ code: 'custom', message: `Dangerous object key "${key}" is not allowed` });
        }
      }
    }),
);

const portableJsonValueSchema: z.ZodType<PortableJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z
      .number()
      .finite()
      .refine((value) => Math.abs(value) <= Number.MAX_SAFE_INTEGER, 'Number exceeds the safe numeric range'),
    z.string().max(GRAPH_BUILDER_LIMITS.maxStringLength),
    z.array(portableJsonValueSchema).max(GRAPH_BUILDER_LIMITS.maxArrayItems),
    portableJsonObjectSchema,
  ]),
);

export { portableJsonObjectSchema as graphBuilderPortableJsonObjectSchema };
export { portableJsonValueSchema as graphBuilderPortableJsonValueSchema };

export const graphBuilderCannotCompleteReasonCodeSchema = z.enum([
  'unsupported-capability',
  'insufficient-context',
  'unsafe-request',
  'request-conflict',
  'other',
]);
export type GraphBuilderCannotCompleteReasonCode = z.infer<typeof graphBuilderCannotCompleteReasonCodeSchema>;

export const graphBuilderNodeReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('created'),
    clientId: boundedIdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal('existing'),
    nodeId: boundedIdentifierSchema,
  }),
]);
export type GraphBuilderNodeReference = z.infer<typeof graphBuilderNodeReferenceSchema>;

export const graphBuilderEndpointSchema = z.strictObject({
  node: graphBuilderNodeReferenceSchema,
  port: boundedIdentifierSchema,
});
export type GraphBuilderEndpoint = z.infer<typeof graphBuilderEndpointSchema>;

export const graphBuilderNodePreconditionSchema = z
  .strictObject({
    type: boundedIdentifierSchema.optional(),
    title: z.string().max(GRAPH_BUILDER_LIMITS.maxStringLength).optional(),
    disabled: z.boolean().optional(),
    isConditional: z.boolean().optional(),
    isSplitRun: z.boolean().optional(),
    splitRunMax: z.number().int().safe().positive().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'A precondition must check at least one field');
export type GraphBuilderNodePrecondition = z.infer<typeof graphBuilderNodePreconditionSchema>;

const createNodeOperationSchema = z.strictObject({
  op: z.literal('createNode'),
  clientId: safeDictionaryKeySchema,
  authoringChoiceId: boundedIdentifierSchema,
  settings: portableJsonObjectSchema.optional(),
});

const cloneNodeOperationSchema = z.strictObject({
  op: z.literal('cloneNode'),
  clientId: safeDictionaryKeySchema,
  source: z.strictObject({
    kind: z.literal('existing'),
    nodeId: boundedIdentifierSchema,
  }),
  precondition: graphBuilderNodePreconditionSchema.optional(),
});

const updateNodeSettingsOperationSchema = z.strictObject({
  op: z.literal('updateNodeSettings'),
  node: graphBuilderNodeReferenceSchema,
  settings: portableJsonObjectSchema,
  precondition: graphBuilderNodePreconditionSchema.optional(),
});

const nodeEnvelopeSchema = z
  .strictObject({
    title: z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxStringLength).optional(),
    disabled: z.boolean().optional(),
    isConditional: z.boolean().optional(),
    isSplitRun: z.boolean().optional(),
    splitRunMax: z.number().int().safe().positive().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'An envelope update must set at least one field');

const updateNodeEnvelopeOperationSchema = z.strictObject({
  op: z.literal('updateNodeEnvelope'),
  node: graphBuilderNodeReferenceSchema,
  envelope: nodeEnvelopeSchema,
  precondition: graphBuilderNodePreconditionSchema.optional(),
});

const deleteNodeOperationSchema = z.strictObject({
  op: z.literal('deleteNode'),
  node: graphBuilderNodeReferenceSchema,
  precondition: graphBuilderNodePreconditionSchema.optional(),
});

const connectOperationSchema = z.strictObject({
  op: z.literal('connect'),
  from: graphBuilderEndpointSchema,
  to: graphBuilderEndpointSchema,
});

const disconnectOperationSchema = z.strictObject({
  op: z.literal('disconnect'),
  from: graphBuilderEndpointSchema,
  to: graphBuilderEndpointSchema,
});

export const graphPatchOperationSchema = z.discriminatedUnion('op', [
  createNodeOperationSchema,
  cloneNodeOperationSchema,
  updateNodeSettingsOperationSchema,
  updateNodeEnvelopeOperationSchema,
  deleteNodeOperationSchema,
  connectOperationSchema,
  disconnectOperationSchema,
]);
export type GraphPatchOperation = z.infer<typeof graphPatchOperationSchema>;
export type CreateNodeOperation = z.infer<typeof createNodeOperationSchema>;
export type CloneNodeOperation = z.infer<typeof cloneNodeOperationSchema>;
export type UpdateNodeSettingsOperation = z.infer<typeof updateNodeSettingsOperationSchema>;
export type UpdateNodeEnvelopeOperation = z.infer<typeof updateNodeEnvelopeOperationSchema>;
export type DeleteNodeOperation = z.infer<typeof deleteNodeOperationSchema>;
export type ConnectOperation = z.infer<typeof connectOperationSchema>;
export type DisconnectOperation = z.infer<typeof disconnectOperationSchema>;

export const graphPatchProposalSchema = z
  .strictObject({
    protocolVersion: z.literal(GRAPH_BUILDER_PROTOCOL_VERSION),
    operations: z.array(graphPatchOperationSchema).min(1).max(GRAPH_BUILDER_LIMITS.maxPatchOperations),
  })
  .superRefine((proposal, context) => {
    const clientIds = new Set<string>();
    proposal.operations.forEach((operation, operationIndex) => {
      if (operation.op !== 'createNode' && operation.op !== 'cloneNode') {
        return;
      }
      if (clientIds.has(operation.clientId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate created-node clientId "${operation.clientId}"`,
          path: ['operations', operationIndex, 'clientId'],
        });
      }
      clientIds.add(operation.clientId);
    });
  });
export type GraphPatchProposal = z.infer<typeof graphPatchProposalSchema>;

export const graphPatchSchema = graphPatchProposalSchema.extend({
  patchId: boundedIdentifierSchema,
  expectedDraftRevision: z.number().int().safe().nonnegative(),
});
export type GraphPatch = z.infer<typeof graphPatchSchema>;

export const GRAPH_BUILDER_TRANSACTIONAL_READ_TYPES = {
  searchNodeTypes: 'search-node-types',
  readVirtualDocument: 'read-virtual-document',
  getNodeTemplates: 'get-node-templates',
  getDiagnostics: 'get-diagnostics',
  listProjectResources: 'list-project-resources',
} as const;

const searchNodeTypesReadRequestSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_READ_TYPES.searchNodeTypes),
  queries: uniqueStringArraySchema(boundedTextSchema(500), { min: 1, max: 16, fieldName: 'queries' }),
  limit: z.number().int().safe().min(1).max(50),
});

const getNodeSpecsReadRequestSchema = z
  .strictObject({
    type: z.literal('get-node-specs'),
    authoringChoiceIds: uniqueStringArraySchema(boundedIdentifierSchema, {
      min: 1,
      max: 32,
      fieldName: 'authoringChoiceIds',
    }),
    authoringSettings: portableJsonObjectSchema.optional(),
  })
  .superRefine((request, context) => {
    if (request.authoringSettings === undefined) {
      return;
    }
    if (request.authoringChoiceIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'authoringSettings requires exactly one authoringChoiceId',
        path: ['authoringChoiceIds'],
      });
    }
    if (Object.keys(request.authoringSettings).length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'authoringSettings must contain at least one setting',
        path: ['authoringSettings'],
      });
    }
  });

const readVirtualDocumentReadRequestSchema = z
  .strictObject({
    type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_READ_TYPES.readVirtualDocument),
    path: virtualDocumentPathSchema,
    startLine: z.number().int().safe().positive().optional(),
    lineCount: z.number().int().safe().min(1).max(2_000).optional(),
    startOffset: z.number().int().safe().nonnegative().optional(),
  })
  .superRefine((request, context) => {
    if (request.startOffset !== undefined && (request.startLine !== undefined || request.lineCount !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'startOffset cannot be combined with startLine or lineCount',
        path: ['startOffset'],
      });
    }
  });

const getNodeTemplatesReadRequestSchema = z
  .strictObject({
    type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_READ_TYPES.getNodeTemplates),
    authoringChoiceIds: uniqueStringArraySchema(boundedIdentifierSchema, {
      min: 1,
      max: 32,
      fieldName: 'authoringChoiceIds',
    }),
    authoringSettings: portableJsonObjectSchema.optional(),
  })
  .superRefine((request, context) => {
    if (request.authoringSettings === undefined) {
      return;
    }
    if (request.authoringChoiceIds.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'authoringSettings requires exactly one authoringChoiceId',
        path: ['authoringChoiceIds'],
      });
    }
    if (Object.keys(request.authoringSettings).length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'authoringSettings must contain at least one setting',
        path: ['authoringSettings'],
      });
    }
  });

const inspectDraftReadRequestSchema = z.strictObject({
  type: z.literal('inspect-draft'),
  nodeIds: uniqueStringArraySchema(boundedIdentifierSchema, { min: 1, max: 64, fieldName: 'nodeIds' }),
  fields: uniqueStringArraySchema(boundedIdentifierSchema, { min: 1, max: 32, fieldName: 'fields' }),
});

const inspectDraftDiffReadRequestSchema = z.strictObject({
  type: z.literal('inspect-draft-diff'),
});

const getDiagnosticsReadRequestSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_READ_TYPES.getDiagnostics),
});

const listProjectResourcesReadRequestSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_READ_TYPES.listProjectResources),
  kinds: uniqueStringArraySchema(boundedIdentifierSchema, { min: 1, max: 16, fieldName: 'kinds' }),
  query: z.string().max(500).optional(),
  limit: z.number().int().safe().min(1).max(50),
});

export const graphBuilderTransactionalReadRequestSchema = z.discriminatedUnion('type', [
  searchNodeTypesReadRequestSchema,
  readVirtualDocumentReadRequestSchema,
  getNodeTemplatesReadRequestSchema,
  getDiagnosticsReadRequestSchema,
  listProjectResourcesReadRequestSchema,
]);
export type GraphBuilderTransactionalReadRequest = z.infer<typeof graphBuilderTransactionalReadRequestSchema>;

export const graphBuilderReadRequestSchema = z.discriminatedUnion('type', [
  searchNodeTypesReadRequestSchema,
  readVirtualDocumentReadRequestSchema,
  getNodeTemplatesReadRequestSchema,
  getDiagnosticsReadRequestSchema,
  listProjectResourcesReadRequestSchema,
  getNodeSpecsReadRequestSchema,
  inspectDraftReadRequestSchema,
  inspectDraftDiffReadRequestSchema,
]);
export type GraphBuilderReadRequest = z.infer<typeof graphBuilderReadRequestSchema>;

export const graphBuilderReadErrorSchema = z.strictObject({
  code: boundedIdentifierSchema,
  message: z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxDiagnosticMessageLength),
});
export type GraphBuilderReadError = z.infer<typeof graphBuilderReadErrorSchema>;

export const graphBuilderReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    requestId: boundedIdentifierSchema,
    requestIndex: z.number().int().safe().nonnegative(),
    observedDraftRevision: z.number().int().safe().nonnegative(),
    status: z.literal('ok'),
    payload: portableJsonValueSchema,
  }),
  z.strictObject({
    requestId: boundedIdentifierSchema,
    requestIndex: z.number().int().safe().nonnegative(),
    observedDraftRevision: z.number().int().safe().nonnegative(),
    status: z.enum(['unsupported', 'failed']),
    error: graphBuilderReadErrorSchema,
  }),
]);
export type GraphBuilderReadResult = z.infer<typeof graphBuilderReadResultSchema>;

export const GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES = {
  requestContext: 'request-context',
  applyPatch: 'apply-patch',
  replaceDocument: 'replace-document',
  ready: 'ready',
  noChange: 'no-change',
  clarify: 'clarify',
  cannotComplete: 'cannot-complete',
} as const;

const applyPatchDecisionSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.applyPatch),
  baseRevision: z.number().int().safe().nonnegative(),
  unifiedDiff: graphBuilderUnifiedDiffSchema,
  summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength).optional(),
});
const replaceDocumentDecisionSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.replaceDocument),
  baseRevision: z.number().int().safe().nonnegative(),
  path: virtualDocumentPathSchema,
  content: z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxPortableBytes),
  summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength).optional(),
});
const readyDecisionSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.ready),
  summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength),
});
const noChangeDecisionSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.noChange),
  summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength),
});
const clarifyDecisionSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.clarify),
  question: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxUserQuestionLength),
});
const cannotCompleteDecisionSchema = z.strictObject({
  type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.cannotComplete),
  reasonCode: graphBuilderCannotCompleteReasonCodeSchema,
  reason: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxReasonLength),
});

function rejectDuplicateCanonicalReadRequests(
  decision: { type: string; requests?: readonly unknown[] },
  context: z.RefinementCtx,
): void {
  if (decision.type !== GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.requestContext || decision.requests == null) {
    return;
  }

  const seen = new Set<string>();
  decision.requests.forEach((request, requestIndex) => {
    const canonical = canonicalGraphBuilderStringify(request);
    if (seen.has(canonical)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate canonical read request',
        path: ['requests', requestIndex],
      });
    }
    seen.add(canonical);
  });
}

export const graphBuilderTransactionalDecisionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.requestContext),
      requests: z
        .array(graphBuilderTransactionalReadRequestSchema)
        .min(1)
        .max(GRAPH_BUILDER_LIMITS.maxDecisionRequests),
    }),
    applyPatchDecisionSchema,
    replaceDocumentDecisionSchema,
    readyDecisionSchema,
    noChangeDecisionSchema,
    clarifyDecisionSchema,
    cannotCompleteDecisionSchema,
  ])
  .superRefine(rejectDuplicateCanonicalReadRequests);
export type GraphBuilderTransactionalDecision = z.infer<typeof graphBuilderTransactionalDecisionSchema>;

export const graphBuilderDecisionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal(GRAPH_BUILDER_TRANSACTIONAL_DECISION_TYPES.requestContext),
      requests: z.array(graphBuilderReadRequestSchema).min(1).max(GRAPH_BUILDER_LIMITS.maxDecisionRequests),
    }),
    applyPatchDecisionSchema,
    replaceDocumentDecisionSchema,
    readyDecisionSchema,
    noChangeDecisionSchema,
    clarifyDecisionSchema,
    cannotCompleteDecisionSchema,
  ])
  .superRefine(rejectDuplicateCanonicalReadRequests);
export type GraphBuilderDecision = z.infer<typeof graphBuilderDecisionSchema>;

export const graphDiagnosticSchema = z.strictObject({
  diagnosticKey: boundedIdentifierSchema,
  ruleId: boundedIdentifierSchema,
  rulesVersion: boundedIdentifierSchema,
  severity: z.enum(['error', 'warning', 'info']),
  verification: z.enum(['verified', 'unverified']),
  message: z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxDiagnosticMessageLength),
  graphId: boundedIdentifierSchema.optional(),
  nodeId: boundedIdentifierSchema.optional(),
  clientId: boundedIdentifierSchema.optional(),
  portId: boundedIdentifierSchema.optional(),
  settingPath: z.string().max(GRAPH_BUILDER_LIMITS.maxSettingPathLength).optional(),
  operationIndex: z.number().int().safe().nonnegative().optional(),
  expected: portableJsonValueSchema.optional(),
  actual: portableJsonValueSchema.optional(),
  repairHint: z.string().max(GRAPH_BUILDER_LIMITS.maxDiagnosticMessageLength).optional(),
});
export type GraphDiagnostic = z.infer<typeof graphDiagnosticSchema>;

export const graphValidationResultSchema = z
  .strictObject({
    completeness: z.enum(['complete', 'incomplete']),
    diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
    blockingDiagnosticKeys: z.array(boundedIdentifierSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  })
  .superRefine((result, context) => {
    const diagnosticKeys = new Set<string>();
    result.diagnostics.forEach((diagnostic, index) => {
      if (diagnosticKeys.has(diagnostic.diagnosticKey)) {
        context.addIssue({
          code: 'custom',
          message: `Diagnostic key "${diagnostic.diagnosticKey}" is duplicated`,
          path: ['diagnostics', index, 'diagnosticKey'],
        });
      }
      diagnosticKeys.add(diagnostic.diagnosticKey);
    });
    const blockingDiagnosticKeys = new Set<string>();
    result.blockingDiagnosticKeys.forEach((diagnosticKey, index) => {
      if (blockingDiagnosticKeys.has(diagnosticKey)) {
        context.addIssue({
          code: 'custom',
          message: `Blocking diagnostic key "${diagnosticKey}" is duplicated`,
          path: ['blockingDiagnosticKeys', index],
        });
      }
      blockingDiagnosticKeys.add(diagnosticKey);
      if (!diagnosticKeys.has(diagnosticKey)) {
        context.addIssue({
          code: 'custom',
          message: `Blocking diagnostic "${diagnosticKey}" is not present in diagnostics`,
          path: ['blockingDiagnosticKeys', index],
        });
      }
    });
  });
export type GraphValidationResult = z.infer<typeof graphValidationResultSchema>;

export const graphBuilderConnectionDescriptorSchema = z.strictObject({
  outputNodeId: boundedIdentifierSchema,
  outputId: boundedIdentifierSchema,
  inputNodeId: boundedIdentifierSchema,
  inputId: boundedIdentifierSchema,
});
export type GraphBuilderConnectionDescriptor = z.infer<typeof graphBuilderConnectionDescriptorSchema>;

const graphBuilderNodeDeltaSchema = z.strictObject({
  nodeId: boundedIdentifierSchema,
  type: boundedIdentifierSchema,
  title: z.string().max(GRAPH_BUILDER_LIMITS.maxDeltaNodeTitleLength),
});

const graphBuilderUpdatedNodeDeltaSchema = graphBuilderNodeDeltaSchema.extend({
  changedFields: z.array(z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxSettingPathLength)).min(1).max(128),
});

export const graphDraftDeltaSchema = z.strictObject({
  graphId: boundedIdentifierSchema,
  addedNodeCount: z.number().int().safe().nonnegative().optional(),
  removedNodeCount: z.number().int().safe().nonnegative().optional(),
  updatedNodeCount: z.number().int().safe().nonnegative().optional(),
  addedConnectionCount: z.number().int().safe().nonnegative().optional(),
  removedConnectionCount: z.number().int().safe().nonnegative().optional(),
  truncated: z.boolean().optional(),
  addedNodes: z.array(graphBuilderNodeDeltaSchema).max(GRAPH_BUILDER_LIMITS.maxDeltaEntriesPerKind),
  removedNodes: z.array(graphBuilderNodeDeltaSchema).max(GRAPH_BUILDER_LIMITS.maxDeltaEntriesPerKind),
  updatedNodes: z.array(graphBuilderUpdatedNodeDeltaSchema).max(GRAPH_BUILDER_LIMITS.maxDeltaEntriesPerKind),
  addedConnections: z.array(graphBuilderConnectionDescriptorSchema).max(GRAPH_BUILDER_LIMITS.maxDeltaEntriesPerKind),
  removedConnections: z.array(graphBuilderConnectionDescriptorSchema).max(GRAPH_BUILDER_LIMITS.maxDeltaEntriesPerKind),
});
export type GraphDraftDelta = z.infer<typeof graphDraftDeltaSchema>;

export const graphBuilderProjectDraftDeltaSchema = z
  .strictObject({
    graphDeltas: z.array(graphDraftDeltaSchema).max(32),
  })
  .superRefine((delta, context) => {
    const graphIds = new Set<string>();
    delta.graphDeltas.forEach((graphDelta, graphIndex) => {
      if (graphIds.has(graphDelta.graphId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate graph delta for "${graphDelta.graphId}"`,
          path: ['graphDeltas', graphIndex, 'graphId'],
        });
      }
      graphIds.add(graphDelta.graphId);
    });
  });
export type GraphBuilderProjectDraftDelta = z.infer<typeof graphBuilderProjectDraftDeltaSchema>;

export const graphBuilderTouchedScopeSchema = z.strictObject({
  graphIds: z.array(boundedIdentifierSchema).min(1).max(8),
  nodeIds: z.array(boundedIdentifierSchema).max(GRAPH_BUILDER_LIMITS.maxPatchOperations * 2),
  connectionKeys: z.array(z.string().min(1).max(1_024)).max(GRAPH_BUILDER_LIMITS.maxPatchOperations * 2),
  operationIndices: z.array(z.number().int().safe().nonnegative()).max(GRAPH_BUILDER_LIMITS.maxPatchOperations),
});
export type GraphBuilderTouchedScope = z.infer<typeof graphBuilderTouchedScopeSchema>;

export const graphBuilderSafeNodeProjectionSchema = z.strictObject({
  nodeId: boundedIdentifierSchema,
  type: boundedIdentifierSchema,
  authoringChoiceId: boundedIdentifierSchema.optional(),
  title: z.string().max(GRAPH_BUILDER_LIMITS.maxStringLength),
  runMode: boundedIdentifierSchema.optional(),
  safeSettings: portableJsonObjectSchema.optional(),
});
export type GraphBuilderSafeNodeProjection = z.infer<typeof graphBuilderSafeNodeProjectionSchema>;

export const graphBuilderProjectionSchema = z.strictObject({
  protocolVersion: z.literal(GRAPH_BUILDER_PROTOCOL_VERSION),
  projectId: boundedIdentifierSchema,
  graphId: boundedIdentifierSchema,
  draftRevision: z.number().int().safe().nonnegative(),
  nodes: z.array(graphBuilderSafeNodeProjectionSchema).max(2_048),
  connections: z.array(graphBuilderConnectionDescriptorSchema).max(4_096),
  diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  delta: graphDraftDeltaSchema.optional(),
});
export type GraphBuilderProjection = z.infer<typeof graphBuilderProjectionSchema>;

export const graphBuilderAuthorizationScopeSchema = z
  .strictObject({
    allowedGraphIds: z.array(boundedIdentifierSchema).min(1).max(32),
    allowedOperations: z
      .array(
        z.enum([
          'createNode',
          'cloneNode',
          'updateNodeSettings',
          'updateNodeEnvelope',
          'deleteNode',
          'connect',
          'disconnect',
        ]),
      )
      .min(1),
    allowSemanticCrossGraphPropagation: z.boolean(),
    sensitiveFieldAccess: z.literal('none'),
  })
  .superRefine((scope, context) => {
    for (const field of ['allowedGraphIds', 'allowedOperations'] as const) {
      if (new Set(scope[field]).size !== scope[field].length) {
        context.addIssue({
          code: 'custom',
          message: `${field} must not contain duplicate values`,
          path: [field],
        });
      }
    }
  });
export type GraphBuilderAuthorizationScope = z.infer<typeof graphBuilderAuthorizationScopeSchema>;

const createdNodeIdsSchema = z
  .record(boundedIdentifierSchema, boundedIdentifierSchema)
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (GRAPH_BUILDER_DANGEROUS_KEYS.has(key)) {
        context.addIssue({ code: 'custom', message: `Dangerous object key "${key}" is not allowed` });
      }
    }
  });

const appliedDocumentPatchResultSchema = z.strictObject({
  disposition: z.literal('applied'),
  patchId: boundedIdentifierSchema,
  baseRevision: z.number().int().safe().nonnegative(),
  draftRevision: z.number().int().safe().nonnegative(),
  delta: graphBuilderProjectDraftDeltaSchema,
  diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
});

const noOpDocumentPatchResultSchema = z.strictObject({
  disposition: z.literal('no-op'),
  patchId: boundedIdentifierSchema,
  baseRevision: z.number().int().safe().nonnegative(),
  draftRevision: z.number().int().safe().nonnegative(),
  delta: graphBuilderProjectDraftDeltaSchema,
  diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
});

const rejectedDocumentPatchResultSchema = z.strictObject({
  disposition: z.literal('rejected'),
  patchId: boundedIdentifierSchema,
  baseRevision: z.number().int().safe().nonnegative(),
  draftRevision: z.number().int().safe().nonnegative(),
  diagnostics: z.array(graphDiagnosticSchema).min(1).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  attemptedDelta: graphBuilderProjectDraftDeltaSchema.optional(),
});

const freshGraphBuilderDocumentPatchResultUnionSchema = z.discriminatedUnion('disposition', [
  appliedDocumentPatchResultSchema,
  noOpDocumentPatchResultSchema,
  rejectedDocumentPatchResultSchema,
]);

function validateFreshDocumentPatchResult(
  result: z.infer<typeof freshGraphBuilderDocumentPatchResultUnionSchema>,
  context: z.RefinementCtx,
): void {
  if (result.disposition === 'applied' && result.draftRevision !== result.baseRevision + 1) {
    context.addIssue({
      code: 'custom',
      message: 'An applied document patch must advance the draft revision exactly once',
      path: ['draftRevision'],
    });
  }
  if (
    (result.disposition === 'no-op' || result.disposition === 'rejected') &&
    result.draftRevision !== result.baseRevision
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A non-applied document patch must retain its base revision',
      path: ['draftRevision'],
    });
  }
}

export const freshGraphBuilderDocumentPatchResultSchema = freshGraphBuilderDocumentPatchResultUnionSchema.superRefine(
  validateFreshDocumentPatchResult,
);
export type FreshGraphBuilderDocumentPatchResult = z.infer<typeof freshGraphBuilderDocumentPatchResultSchema>;

const replayedDocumentPatchResultSchema = z.strictObject({
  disposition: z.literal('replayed'),
  patchId: boundedIdentifierSchema,
  baseRevision: z.number().int().safe().nonnegative(),
  draftRevision: z.number().int().safe().nonnegative(),
  diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  original: freshGraphBuilderDocumentPatchResultSchema,
});

export const graphBuilderDocumentPatchResultSchema = z
  .discriminatedUnion('disposition', [
    appliedDocumentPatchResultSchema,
    noOpDocumentPatchResultSchema,
    rejectedDocumentPatchResultSchema,
    replayedDocumentPatchResultSchema,
  ])
  .superRefine((result, context) => {
    if (result.disposition !== 'replayed') {
      validateFreshDocumentPatchResult(result, context);
      return;
    }
    if (
      result.original.patchId !== result.patchId ||
      result.original.baseRevision !== result.baseRevision ||
      result.original.draftRevision !== result.draftRevision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Replayed document patch correlation must match the original result',
        path: ['original'],
      });
    }
    if (
      canonicalGraphBuilderStringify(result.original.diagnostics) !== canonicalGraphBuilderStringify(result.diagnostics)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Replayed document patch diagnostics must match the original result',
        path: ['diagnostics'],
      });
    }
  });
export type GraphBuilderDocumentPatchResult = z.infer<typeof graphBuilderDocumentPatchResultSchema>;

const appliedPatchResultSchema = z.strictObject({
  disposition: z.literal('applied'),
  patchId: boundedIdentifierSchema,
  proposalHash: boundedIdentifierSchema,
  previousDraftRevision: z.number().int().safe().nonnegative(),
  draftRevision: z.number().int().safe().nonnegative(),
  createdNodeIds: createdNodeIdsSchema,
  delta: graphDraftDeltaSchema,
  diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
});

const noOpPatchResultSchema = z.strictObject({
  disposition: z.literal('no-op'),
  patchId: boundedIdentifierSchema,
  proposalHash: boundedIdentifierSchema,
  draftRevision: z.number().int().safe().nonnegative(),
  delta: graphDraftDeltaSchema,
  diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
});

const rejectedPatchResultSchema = z.strictObject({
  disposition: z.literal('rejected'),
  patchId: boundedIdentifierSchema,
  proposalHash: boundedIdentifierSchema,
  draftRevision: z.number().int().safe().nonnegative(),
  diagnostics: z.array(graphDiagnosticSchema).min(1).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  attemptedDelta: graphDraftDeltaSchema.optional(),
});

export const freshApplyPatchResultSchema = z.discriminatedUnion('disposition', [
  appliedPatchResultSchema,
  noOpPatchResultSchema,
  rejectedPatchResultSchema,
]);
export type FreshApplyPatchResult = z.infer<typeof freshApplyPatchResultSchema>;

const replayedPatchResultSchema = z
  .strictObject({
    disposition: z.literal('replayed'),
    patchId: boundedIdentifierSchema,
    proposalHash: boundedIdentifierSchema,
    original: freshApplyPatchResultSchema,
  })
  .superRefine((result, context) => {
    if (result.original.patchId !== result.patchId) {
      context.addIssue({
        code: 'custom',
        message: 'Replayed patchId must match the original result',
        path: ['original', 'patchId'],
      });
    }
    if (result.original.proposalHash !== result.proposalHash) {
      context.addIssue({
        code: 'custom',
        message: 'Replayed proposalHash must match the original result',
        path: ['original', 'proposalHash'],
      });
    }
  });

export const applyPatchResultSchema = z.union([freshApplyPatchResultSchema, replayedPatchResultSchema]);
export type ApplyPatchResult = z.infer<typeof applyPatchResultSchema>;

export const graphBuilderBaseIdentitySchema = z.strictObject({
  projectId: boundedIdentifierSchema,
  activeGraphId: boundedIdentifierSchema,
  editorRevision: z.number().int().safe().nonnegative(),
  projectFingerprint: boundedIdentifierSchema,
  registryContractFingerprint: boundedIdentifierSchema,
  referencedProjectsFingerprint: boundedIdentifierSchema,
  policyConfigFingerprint: boundedIdentifierSchema,
  validationRulesVersion: boundedIdentifierSchema,
  protocolVersion: z.literal(GRAPH_BUILDER_PROTOCOL_VERSION),
});
export type GraphBuilderBaseIdentity = z.infer<typeof graphBuilderBaseIdentitySchema>;

export const graphBuilderFailureSchema = z.strictObject({
  code: boundedIdentifierSchema,
  userMessage: z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxDiagnosticMessageLength),
  developerMessage: z.string().min(1).max(GRAPH_BUILDER_LIMITS.maxDiagnosticMessageLength).optional(),
});
export type GraphBuilderFailure = z.infer<typeof graphBuilderFailureSchema>;

export const graphBuilderSessionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('committed'),
    base: graphBuilderBaseIdentitySchema,
    draftRevision: z.number().int().safe().nonnegative(),
    summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength),
  }),
  z.strictObject({
    status: z.literal('no-change'),
    base: graphBuilderBaseIdentitySchema,
    summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength),
  }),
  z.strictObject({
    status: z.literal('cannot-complete'),
    code: graphBuilderCannotCompleteReasonCodeSchema,
    reason: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxReasonLength),
  }),
  z.strictObject({
    status: z.literal('discarded'),
    summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength).optional(),
  }),
  z.strictObject({ status: z.literal('canceled') }),
  z.strictObject({
    status: z.literal('failed'),
    failure: graphBuilderFailureSchema,
    diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  }),
  z.strictObject({
    status: z.literal('budget-exhausted'),
    diagnostics: z.array(graphDiagnosticSchema).max(GRAPH_BUILDER_LIMITS.maxDiagnostics),
  }),
  z.strictObject({
    status: z.literal('conflicted'),
    base: graphBuilderBaseIdentitySchema,
    currentFingerprint: boundedIdentifierSchema,
  }),
  z.strictObject({ status: z.literal('expired') }),
]);
export type GraphBuilderSessionResult = z.infer<typeof graphBuilderSessionResultSchema>;

function parseWithPortablePreflight<T>(
  value: unknown,
  schema: z.ZodType<T>,
  options: { allowLargeText?: boolean } = {},
): T {
  return schema.parse(
    parsePortableJson(
      value,
      options.allowLargeText ? { maxStringLength: GRAPH_BUILDER_LIMITS.maxPortableBytes } : undefined,
    ),
  );
}

export function parseGraphBuilderDecision(value: unknown): GraphBuilderDecision {
  return parseWithPortablePreflight(value, graphBuilderDecisionSchema, { allowLargeText: true });
}

export function parseGraphBuilderTransactionalDecision(value: unknown): GraphBuilderTransactionalDecision {
  return parseWithPortablePreflight(value, graphBuilderTransactionalDecisionSchema, { allowLargeText: true });
}

export function parseGraphPatchProposal(value: unknown): GraphPatchProposal {
  return parseWithPortablePreflight(value, graphPatchProposalSchema);
}

export function parseGraphPatch(value: unknown): GraphPatch {
  return parseWithPortablePreflight(value, graphPatchSchema);
}

export function parseGraphDiagnostic(value: unknown): GraphDiagnostic {
  return parseWithPortablePreflight(value, graphDiagnosticSchema);
}

export function parseGraphBuilderReadResult(value: unknown): GraphBuilderReadResult {
  return parseWithPortablePreflight(value, graphBuilderReadResultSchema);
}

export function parseGraphValidationResult(value: unknown): GraphValidationResult {
  return parseWithPortablePreflight(value, graphValidationResultSchema);
}

export function parseGraphBuilderProjection(value: unknown): GraphBuilderProjection {
  return parseWithPortablePreflight(value, graphBuilderProjectionSchema);
}

export function parseGraphBuilderProjectDraftDelta(value: unknown): GraphBuilderProjectDraftDelta {
  return parseWithPortablePreflight(value, graphBuilderProjectDraftDeltaSchema);
}

export function parseFreshGraphBuilderDocumentPatchResult(value: unknown): FreshGraphBuilderDocumentPatchResult {
  return parseWithPortablePreflight(value, freshGraphBuilderDocumentPatchResultSchema);
}

export function parseGraphBuilderDocumentPatchResult(value: unknown): GraphBuilderDocumentPatchResult {
  return parseWithPortablePreflight(value, graphBuilderDocumentPatchResultSchema);
}

export function parseFreshApplyPatchResult(value: unknown): FreshApplyPatchResult {
  return parseWithPortablePreflight(value, freshApplyPatchResultSchema);
}

export function parseApplyPatchResult(value: unknown): ApplyPatchResult {
  return parseWithPortablePreflight(value, applyPatchResultSchema);
}

export function parseGraphBuilderSessionResult(value: unknown): GraphBuilderSessionResult {
  return parseWithPortablePreflight(value, graphBuilderSessionResultSchema);
}
