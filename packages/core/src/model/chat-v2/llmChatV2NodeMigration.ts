import type { ChartNode } from '../NodeBase.js';

type LegacyLLMChatV2DiagnosticsData = Record<string, unknown> & {
  outputRequestStatus?: unknown;
  outputRequestError?: unknown;
  outputRequestBody?: unknown;
  outputLLMAttempts?: unknown;
};

/**
 * Serialized LLM Chat migrations live beside the node contract, rather than
 * making generic project serialization understand LLM-specific settings.
 * This is deliberately idempotent because deserialization can normalize a
 * graph more than once while it is imported or embedded in a prefab.
 */
export function normalizeSerializedLLMChatV2Node(node: ChartNode): void {
  if (node.type !== 'llmChatV2' || node.data == null || typeof node.data !== 'object') {
    return;
  }

  const data = node.data as LegacyLLMChatV2DiagnosticsData;
  const hadLegacyRequestDiagnostics = data.outputRequestStatus === true || data.outputRequestError === true;

  if (hadLegacyRequestDiagnostics && !Object.hasOwn(data, 'outputLLMAttempts')) {
    data.outputLLMAttempts = true;
  }

  // The original request-details switch also enabled request-body capture.
  // Preserve that still-supported diagnostic independently from the retired
  // status/error ports.
  if (data.outputRequestStatus === true && !Object.hasOwn(data, 'outputRequestBody')) {
    data.outputRequestBody = true;
  }

  delete data.outputRequestStatus;
  delete data.outputRequestError;
}
