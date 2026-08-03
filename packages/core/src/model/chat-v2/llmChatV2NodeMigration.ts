import type { ChartNode } from '../NodeBase.js';

type LegacyLLMChatV2DiagnosticsData = Record<string, unknown> & {
  outputRequestStatus?: unknown;
  outputRequestError?: unknown;
  outputRequestBody?: unknown;
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
  if (data.outputRequestStatus !== true) {
    return;
  }

  // Older projects used one "Output request details" switch. Retain its
  // observable status/error/body outputs after the controls were split.
  if (!Object.hasOwn(data, 'outputRequestError')) {
    data.outputRequestError = true;
  }
  if (!Object.hasOwn(data, 'outputRequestBody')) {
    data.outputRequestBody = true;
  }
}
