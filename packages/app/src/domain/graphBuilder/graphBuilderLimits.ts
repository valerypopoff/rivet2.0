export const GRAPH_BUILDER_PROTOCOL_VERSION = 1 as const;

export const GRAPH_BUILDER_LIMITS = {
  maxArrayItems: 128,
  maxDecisionRequests: 16,
  maxDeltaEntriesPerKind: 64,
  maxDeltaNodeTitleLength: 256,
  maxDiagnosticMessageLength: 2_000,
  maxDiagnostics: 256,
  maxDictionaryEntries: 128,
  maxIdentifierLength: 160,
  maxObjectDepth: 16,
  maxPatchOperations: 128,
  maxPortableBytes: 256 * 1024,
  maxReasonLength: 4_000,
  maxSettingPathLength: 512,
  maxStringLength: 16_384,
  maxSummaryLength: 4_000,
  maxUserQuestionLength: 4_000,
} as const;

export const GRAPH_BUILDER_DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
