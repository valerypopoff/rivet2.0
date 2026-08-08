import type { ChartNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { InputsOrOutputsWithRefs, NodeRunDataWithRefs } from '../../state/dataFlow.js';
import type { OutputRenderMode } from '../renderDataValue/outputRenderTypes.js';

export type NodeOutputRenderPolicyProps = {
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  autoCollapseLlmChatDiagnosticOutputs?: boolean;
  wrapLines?: boolean;
};

export type NodeOutputRendererProps<TNode extends ChartNode = ChartNode> = NodeOutputRenderPolicyProps & {
  node: TNode;
  data: NodeRunDataWithRefs;
  isCompact: boolean;
};

export type FullscreenNodeOutputRendererProps<TNode extends ChartNode = ChartNode> = NodeOutputRenderPolicyProps & {
  node: TNode;
  data: NodeRunDataWithRefs;
};

export type NodeOutputSimpleRendererProps = NodeOutputRenderPolicyProps & {
  outputs: InputsOrOutputsWithRefs;
  isCompact: boolean;
};

export type FullscreenNodeOutputSimpleRendererProps = NodeOutputRenderPolicyProps & {
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown: boolean;
};

export type NodeOutputRenderer<TNode extends ChartNode = ChartNode> = FC<NodeOutputRendererProps<TNode>>;

export type FullscreenNodeOutputRenderer<TNode extends ChartNode = ChartNode> = FC<
  FullscreenNodeOutputRendererProps<TNode>
>;

export type NodeOutputSimpleRenderer = FC<NodeOutputSimpleRendererProps>;

export type FullscreenNodeOutputSimpleRenderer = FC<FullscreenNodeOutputSimpleRendererProps>;
