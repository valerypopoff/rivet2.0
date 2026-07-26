import { z } from 'zod';
import { canonicalGraphBuilderStringify } from './canonicalGraphBuilderValue.js';
import {
  GRAPH_BUILDER_DANGEROUS_KEYS,
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
} from './graphBuilderLimits.js';
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
  updateNodeSettingsOperationSchema,
  updateNodeEnvelopeOperationSchema,
  deleteNodeOperationSchema,
  connectOperationSchema,
  disconnectOperationSchema,
]);
export type GraphPatchOperation = z.infer<typeof graphPatchOperationSchema>;
export type CreateNodeOperation = z.infer<typeof createNodeOperationSchema>;
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
      if (operation.op !== 'createNode') {
        return;
      }
      if (clientIds.has(operation.clientId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate createNode clientId "${operation.clientId}"`,
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

const searchNodeTypesReadRequestSchema = z.strictObject({
  type: z.literal('search-node-types'),
  queries: uniqueStringArraySchema(boundedTextSchema(500), { min: 1, max: 16, fieldName: 'queries' }),
  limit: z.number().int().safe().min(1).max(50),
});

const getNodeSpecsReadRequestSchema = z.strictObject({
  type: z.literal('get-node-specs'),
  authoringChoiceIds: uniqueStringArraySchema(boundedIdentifierSchema, {
    min: 1,
    max: 32,
    fieldName: 'authoringChoiceIds',
  }),
  authoringSettings: portableJsonObjectSchema.optional(),
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
  type: z.literal('get-diagnostics'),
});

const listProjectResourcesReadRequestSchema = z.strictObject({
  type: z.literal('list-project-resources'),
  kinds: uniqueStringArraySchema(boundedIdentifierSchema, { min: 1, max: 16, fieldName: 'kinds' }),
  query: z.string().max(500).optional(),
  limit: z.number().int().safe().min(1).max(50),
});

export const graphBuilderReadRequestSchema = z.discriminatedUnion('type', [
  searchNodeTypesReadRequestSchema,
  getNodeSpecsReadRequestSchema,
  inspectDraftReadRequestSchema,
  inspectDraftDiffReadRequestSchema,
  getDiagnosticsReadRequestSchema,
  listProjectResourcesReadRequestSchema,
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

export const graphBuilderDecisionSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('request-context'),
      requests: z.array(graphBuilderReadRequestSchema).min(1).max(GRAPH_BUILDER_LIMITS.maxDecisionRequests),
    }),
    z.strictObject({
      type: z.literal('propose-patch'),
      proposal: graphPatchProposalSchema,
      afterApply: z.enum(['continue', 'ready-for-preview']),
      summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength).optional(),
    }),
    z.strictObject({
      type: z.literal('ready'),
      summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength),
    }),
    z.strictObject({
      type: z.literal('no-change'),
      summary: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxSummaryLength),
    }),
    z.strictObject({
      type: z.literal('clarify'),
      question: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxUserQuestionLength),
    }),
    z.strictObject({
      type: z.literal('cannot-complete'),
      reasonCode: graphBuilderCannotCompleteReasonCodeSchema,
      reason: boundedTextSchema(GRAPH_BUILDER_LIMITS.maxReasonLength),
    }),
  ])
  .superRefine((decision, context) => {
    if (decision.type !== 'request-context') {
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
  });
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
      .array(z.enum(['createNode', 'updateNodeSettings', 'updateNodeEnvelope', 'deleteNode', 'connect', 'disconnect']))
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

function parseWithPortablePreflight<T>(value: unknown, schema: z.ZodType<T>): T {
  return schema.parse(parsePortableJson(value));
}

export function parseGraphBuilderDecision(value: unknown): GraphBuilderDecision {
  return parseWithPortablePreflight(value, graphBuilderDecisionSchema);
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

export function parseFreshApplyPatchResult(value: unknown): FreshApplyPatchResult {
  return parseWithPortablePreflight(value, freshApplyPatchResultSchema);
}

export function parseApplyPatchResult(value: unknown): ApplyPatchResult {
  return parseWithPortablePreflight(value, applyPatchResultSchema);
}

export function parseGraphBuilderSessionResult(value: unknown): GraphBuilderSessionResult {
  return parseWithPortablePreflight(value, graphBuilderSessionResultSchema);
}
