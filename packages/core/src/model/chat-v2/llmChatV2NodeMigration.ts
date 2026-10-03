import type { ChartNode } from '../NodeBase.js';

/** Repair legacy payloads on read or Save without mutating the supplied data. */
export function normalizeSerializedLLMTemperatureData(nodeType: string, data: ChartNode['data']): ChartNode['data'] {
  if (!['llmChatV2', 'llmProfile'].includes(nodeType) || data == null || typeof data !== 'object') return data;
  const record = data as Record<string, unknown>;
  if (!Object.hasOwn(record, 'temperature')) return data;
  if (record.temperature != null && !(typeof record.temperature === 'number' && Number.isNaN(record.temperature)))
    return data;
  const copy = { ...record };
  delete copy.temperature;
  return copy;
}

type LegacyLLMChatV2DiagnosticsData = Record<string, unknown> & {
  outputRequestStatus?: unknown;
  outputRequestError?: unknown;
  outputRequestBody?: unknown;
  outputLLMAttempts?: unknown;
};

/**
 * Serialized LLM Chat/Profile migrations live beside the node contract, rather than
 * making generic project serialization understand LLM-specific settings.
 * This is deliberately idempotent because deserialization can normalize a
 * graph more than once while it is imported or embedded in a prefab.
 */
export function normalizeSerializedLLMChatV2Node(node: ChartNode): void {
  if (!['llmChatV2', 'llmProfile'].includes(node.type)) return;
  for (const variant of node.variants ?? []) {
    variant.data = normalizeSerializedLLMTemperatureData(node.type, variant.data);
  }
  node.data = normalizeSerializedLLMTemperatureData(node.type, node.data);
  if (node.data == null || typeof node.data !== 'object') return;

  const data = node.data as LegacyLLMChatV2DiagnosticsData;
  if (node.type !== 'llmChatV2') return;
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
