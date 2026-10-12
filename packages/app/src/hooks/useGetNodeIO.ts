import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { ioDefinitionsForNodeState } from '../state/graph.js';
import { type NodeId, type NodeConnection } from '@valerypopoff/rivet2-core';
import {
  canvasIoDefinitionsForNodeState,
  createInputConnectionWarningsAtom,
} from '../state/selectors/canvasGraphSelectors.js';

export function useNodeIO(nodeId: NodeId | undefined) {
  return useAtomValue(ioDefinitionsForNodeState(nodeId));
}

export function useCanvasNodeIO(nodeId: NodeId | undefined) {
  return useAtomValue(canvasIoDefinitionsForNodeState(nodeId));
}

/** Uses this surface's edges, but stays subscribed to live endpoint definitions. */
export function useInputConnectionWarnings(nodeId: NodeId, connections: readonly NodeConnection[]) {
  const warnings = useMemo(() => createInputConnectionWarningsAtom(nodeId, connections), [nodeId, connections]);
  return useAtomValue(warnings);
}
