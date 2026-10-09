import type { Outputs } from './GraphProcessor.js';
import type { NodeOutputDefinition, PortId } from './NodeBase.js';
import { getChatV2ProviderErrorStatusCode } from './chat-v2/chatV2Errors.js';
import { formatCaughtRunError } from '../utils/errors.js';

export type NodeRunFailureSettings = {
  /** Missing on legacy nodes preserves their existing throw behavior. */
  errorOnNon200?: boolean;
  catchRequestFailed?: boolean;
};

export function hasRunFailureOutputs(data: NodeRunFailureSettings): boolean {
  return data.catchRequestFailed === true || data.errorOnNon200 === false;
}

export function getRunFailureOutputDefinitions(data: NodeRunFailureSettings): NodeOutputDefinition[] {
  return hasRunFailureOutputs(data)
    ? [
        { id: 'runFailed' as PortId, title: 'Run failed', dataType: 'boolean' },
        { id: 'runError' as PortId, title: 'Run error', dataType: 'string' },
      ]
    : [];
}

export function shouldCatchRunFailure(data: NodeRunFailureSettings, error: unknown, signal: AbortSignal): boolean {
  // Only the caller's signal proves graph cancellation. A provider or tool can
  // throw AbortError for its own interrupted request while the graph stays live.
  if (signal.aborted) return false;
  if (data.catchRequestFailed === true) return true;
  const status = getChatV2ProviderErrorStatusCode(error);
  return data.errorOnNon200 === false && status != null && (status < 200 || status >= 300);
}

export function withRunSuccessOutputs(data: NodeRunFailureSettings, outputs: Outputs): Outputs {
  if (!hasRunFailureOutputs(data)) return outputs;
  return {
    ...outputs,
    ['runFailed' as PortId]: { type: 'boolean', value: false },
    ['runError' as PortId]: { type: 'control-flow-excluded', value: undefined },
  };
}

/** Never route a partial model answer or fabricated usage through the success branch. */
export function createCaughtRunFailureOutputs(
  definitions: readonly NodeOutputDefinition[],
  error: unknown,
  evidence?: Outputs,
): Outputs {
  const outputs: Outputs = {};
  for (const definition of definitions) {
    outputs[definition.id] = { type: 'control-flow-excluded', value: undefined };
  }
  for (const id of [
    'requestBody',
    'responseBody',
    'llmAttempts',
    'llmProfileSummary',
    'classifierAttempts',
    'classifierProfileSummary',
  ]) {
    const port = id as PortId;
    if (port in outputs && evidence?.[port] != null) outputs[port] = evidence[port]!;
  }
  outputs['runFailed' as PortId] = { type: 'boolean', value: true };
  outputs['runError' as PortId] = { type: 'string', value: formatCaughtRunError(error) };
  return outputs;
}
