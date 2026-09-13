import type { NodeGraph, NodeId, PortId } from '@valerypopoff/rivet2-core';
import type { ProcessDataForNode, StoredInputsOrOutputs } from '../../state/dataFlow.js';

/** Render incoming text only; ordinary consumers still execute with final inputs. */
export function getLiveStreamingInputPreview(
  graph: NodeGraph,
  targetNodeId: NodeId,
  getProcesses: (nodeId: NodeId) => readonly ProcessDataForNode[] | undefined,
): StoredInputsOrOutputs | undefined {
  const target = graph.nodes.find((node) => node.id === targetNodeId);
  if (
    !target ||
    target.disabled ||
    target.type === 'watchStreamingOutput' ||
    target.type === 'stopWatchingStreamingOutput' ||
    target.type === 'graphOutput'
  ) {
    return undefined;
  }

  let inputs: StoredInputsOrOutputs | undefined;
  for (const connection of graph.connections) {
    if (connection.inputNodeId !== targetNodeId || connection.outputId !== 'response') continue;
    const source = graph.nodes.find((node) => node.id === connection.outputNodeId);
    if (
      source?.type !== 'llmChatV2' ||
      source.disabled ||
      (source.data as { useAsGraphPartialOutput?: boolean } | undefined)?.useAsGraphPartialOutput !== true
    )
      continue;

    const processes = getProcesses(source.id);
    const process = processes?.[processes.length - 1];
    // A split invocation has multiple concurrent responses, not one scalar
    // input. Keep its existing split output inspector instead of mixing items.
    if (!process || source.isSplitRun || process.data.status?.type !== 'running') continue;
    // A parent graph view can contain several concurrent synthetic Watch runs.
    // Their node IDs are shared; picking the last one would present an arbitrary
    // iteration as this consumer's input. Keep the normal invocation inspector.
    if (processes!.some((candidate) => candidate !== process && candidate.data.status?.type === 'running')) continue;
    const response = process.data.outputData?.['response' as PortId];
    if (!response || response.type === 'control-flow-excluded') continue;
    inputs ??= {} as StoredInputsOrOutputs;
    // Reuse the producer's bounded, ref-backed value without cloning text or
    // allocating another history entry for every connected consumer.
    inputs[connection.inputId] = response;
  }
  return inputs;
}
