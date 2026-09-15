import { type NodeConnection, type ChartNode, type NodeGraph } from '@valerypopoff/rivet2-core';
import { atom } from 'jotai';

export type NodesClipboardItem = {
  type: 'nodes';
  nodes: ChartNode[];
  connections: NodeConnection[];
};

export type GraphsClipboardItem = {
  type: 'graphs';
  graphs: NodeGraph[];
} & ({ source: 'graph' } | { source: 'folder'; sourceFolderPath: string });

export type ClipboardItem = NodesClipboardItem | GraphsClipboardItem;

export const clipboardState = atom<ClipboardItem | undefined>(undefined);
