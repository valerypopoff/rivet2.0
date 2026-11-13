import type {
  CodeNode,
  CodeNewNode,
  ExpressionNode,
  ExtractObjectPathNode,
  JSFilterNode,
  JSMapNode,
  ProcessEvents,
} from '@valerypopoff/rivet2-core';
import type { NodeRunData } from '../state/dataFlow.js';
import { sanitizeInputsOrOutputs, sanitizeSplitOutputs } from '../utils/executionDataSanitization.js';
import { getRecordedNodeTimingPatch } from '../utils/recordedNodeTiming.js';

/** Event payload normalization is shared; tab selection and persistence remain adapter-owned. */
export const nodeExecutionData = {
  start(event: ProcessEvents['nodeStart'], includeDebugData = true): Partial<NodeRunData> {
    return {
      diagnosticsIncomplete: isIncomplete(event),
      ...(includeDebugData ? getNodeRunDebugData(event.node) : {}),
      inputData: sanitizeInputsOrOutputs(event.inputs),
      ...getRecordedNodeTimingPatch(event, 'start'),
      status: { type: 'running' },
      startedAt: Date.now(),
    };
  },
  finish(event: ProcessEvents['nodeFinish']): Partial<NodeRunData> {
    return {
      diagnosticsIncomplete: isIncomplete(event),
      outputData: sanitizeInputsOrOutputs(event.outputs),
      status: { type: 'ok' },
      finishedAt: Date.now(),
      durationMs: event.durationMs,
      ...getRecordedNodeTimingPatch(event, 'terminal'),
      splitRunDurationMs: event.splitRunDurationMs,
      ...(event.streamingWatchTerminal ? { streamingWatchTerminal: true } : {}),
    };
  },
  excluded(event: ProcessEvents['nodeExcluded'], includeDebugData = true): Partial<NodeRunData> {
    return {
      diagnosticsIncomplete: isIncomplete(event),
      ...(includeDebugData ? getNodeRunDebugData(event.node) : {}),
      inputData: sanitizeInputsOrOutputs(event.inputs),
      outputData: sanitizeInputsOrOutputs(event.outputs),
      ...getRecordedNodeTimingPatch(event, 'excluded'),
      status: { type: 'notRan', reason: event.reason },
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };
  },
  error(event: ProcessEvents['nodeError']): Partial<NodeRunData> {
    return {
      diagnosticsIncomplete: isIncomplete(event),
      ...(isIncomplete(event) ? { outputData: {}, splitOutputData: {} } : {}),
      status: { type: 'error', error: typeof event.error === 'string' ? event.error : event.error.toString() },
      finishedAt: Date.now(),
      durationMs: event.durationMs,
      ...getRecordedNodeTimingPatch(event, 'terminal'),
      splitRunDurationMs: event.splitRunDurationMs,
      ...(event.outputs === undefined ? {} : { outputData: sanitizeInputsOrOutputs(event.outputs) }),
      ...(event.splitOutputs === undefined ? {} : { splitOutputData: sanitizeSplitOutputs(event.splitOutputs) }),
    };
  },
  partial(event: ProcessEvents['partialOutput']): Partial<NodeRunData> {
    const outputs = sanitizeInputsOrOutputs(event.outputs);
    return {
      diagnosticsIncomplete: isIncomplete(event),
      ...(event.node.isSplitRun ? { splitOutputData: { [event.index]: outputs } } : { outputData: outputs }),
    };
  },
};

function isIncomplete(event: object): boolean {
  return (event as { diagnosticsIncomplete?: boolean }).diagnosticsIncomplete === true;
}

function getNodeRunDebugData(node: ProcessEvents['nodeStart']['node']) {
  if (node.type === 'code') {
    return {
      debugData: {
        codeSource: (node as CodeNode).data.code,
      },
    };
  }

  if (node.type === 'codeNew') {
    return {
      debugData: {
        codeSource: (node as CodeNewNode).data.code,
      },
    };
  }

  if (node.type === 'expression') {
    return {
      debugData: {
        expressionSource: (node as ExpressionNode).data.expression,
      },
    };
  }

  if (node.type === 'extractObjectPath') {
    return {
      debugData: {
        extractObjectPathSource: (node as ExtractObjectPathNode).data.path,
        extractObjectPathUsePathInput: (node as ExtractObjectPathNode).data.usePathInput,
      },
    };
  }

  if (node.type === 'jsFilter' || node.type === 'jsMap') {
    return {
      debugData: {
        jsListCallbackBodySource: (node as JSFilterNode | JSMapNode).data.callbackBody,
      },
    };
  }

  return {};
}
