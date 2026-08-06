import { type NodeOfType, type BuiltInNodeType, type ChartNode } from '@valerypopoff/rivet2-core';
import { type FC, useMemo } from 'react';
import { chatNodeDescriptor } from '../components/nodes/ChatNode.js';
import { loopControllerNodeDescriptor } from '../components/nodes/LoopControllerNode.js';
import { readDirectoryNodeDescriptor } from '../components/nodes/ReadDirectoryNode.js';
import { subgraphNodeDescriptor } from '../components/nodes/SubGraphNode.js';
import { userInputNodeDescriptor } from '../components/nodes/UserInputNode.js';
import { ObjectNodeDescriptor } from '../components/nodes/ObjectNode.js';
import { commentNodeDescriptor } from '../components/nodes/CommentNode';
import { imageNodeDescriptor } from '../components/nodes/ImageNode';
import { audioNodeDescriptor } from '../components/nodes/AudioNode';
import { appendToDatasetNodeDescriptor } from '../components/nodes/AppendToDatasetNode';
import { pluginRefreshCounterState } from '../state/plugins';
import { loadDatasetNodeDescriptor } from '../components/nodes/LoadDatasetNode';
import { datasetNearestNeighborsNodeDescriptor } from '../components/nodes/DatasetNearestNeighborsNode';
import { getDatasetRowNodeDescriptor } from '../components/nodes/GetDatasetRowNode';
import { replaceDatasetNodeDescriptor } from '../components/nodes/ReplaceDatasetNode';
import { codeNewNodeDescriptor } from '../components/nodes/CodeNewNode';
import { expressionNodeDescriptor } from '../components/nodes/ExpressionNode';
import { jsFilterNodeDescriptor, jsMapNodeDescriptor } from '../components/nodes/JSListNode';
import { extractObjectPathNodeDescriptor } from '../components/nodes/ExtractObjectPathNode';
import { httpCallNodeDescriptor } from '../components/nodes/HttpCallNode.js';
import { promptNodeDescriptor } from '../components/nodes/PromptNode.js';
import { booleanNodeDescriptor } from '../components/nodes/BooleanNode.js';
import { compareNodeDescriptor } from '../components/nodes/CompareNode.js';
import { coalesceNodeDescriptor } from '../components/nodes/CoalesceNode.js';
import { passthroughNodeDescriptor } from '../components/nodes/PassthroughNode.js';
import { dataBusNodeDescriptor } from '../components/nodes/DataBusNode.js';
import { llmChatV2NodeDescriptor } from '../components/nodes/LLMChatV2Node.js';
import { llmProfileNodeDescriptor } from '../components/nodes/LLMProfileNode.js';
import { useAtomValue } from 'jotai';
import { useProjectNodeRegistry } from './useProjectNodeRegistry';
import type { NodeOutputCopyValueProjector } from '../utils/executionDataCopyValue.js';
import type {
  FullscreenNodeOutputRenderer,
  FullscreenNodeOutputSimpleRenderer,
  NodeOutputRenderer,
  NodeOutputSimpleRenderer,
} from '../components/nodeOutput/nodeOutputRendererTypes.js';

export type UnknownNodeComponentDescriptor = {
  Body?: FC<{ node: ChartNode }>;
  Output?: NodeOutputRenderer<ChartNode>;
  Editor?: FC<{ node: ChartNode; onChange?: (node: ChartNode) => void }>;
  FullscreenOutput?: FullscreenNodeOutputRenderer<ChartNode>;
  OutputSimple?: NodeOutputSimpleRenderer;
  FullscreenOutputSimple?: FullscreenNodeOutputSimpleRenderer;
  getCopyValueData?: NodeOutputCopyValueProjector;
  defaultRenderMarkdown?: boolean;
};

export type NodeComponentDescriptor<T extends BuiltInNodeType> = {
  Body?: FC<{ node: NodeOfType<T> }>;
  Output?: NodeOutputRenderer<NodeOfType<T>>;
  Editor?: FC<{ node: NodeOfType<T>; onChange?: (node: NodeOfType<T>) => void }>;
  FullscreenOutput?: FullscreenNodeOutputRenderer<NodeOfType<T>>;
  OutputSimple?: NodeOutputSimpleRenderer;
  FullscreenOutputSimple?: FullscreenNodeOutputSimpleRenderer;
  getCopyValueData?: NodeOutputCopyValueProjector;
  defaultRenderMarkdown?: boolean;
};

export type NodeComponentDescriptors = {
  [P in BuiltInNodeType]: NodeComponentDescriptor<P>;
};

const overriddenDescriptors: Partial<NodeComponentDescriptors> = {
  chat: chatNodeDescriptor,
  loopController: loopControllerNodeDescriptor,
  readDirectory: readDirectoryNodeDescriptor,
  subGraph: subgraphNodeDescriptor,
  userInput: userInputNodeDescriptor,
  object: ObjectNodeDescriptor,
  comment: commentNodeDescriptor,
  image: imageNodeDescriptor,
  audio: audioNodeDescriptor,
  appendToDataset: appendToDatasetNodeDescriptor,
  loadDataset: loadDatasetNodeDescriptor,
  datasetNearestNeighbors: datasetNearestNeighborsNodeDescriptor,
  getDatasetRow: getDatasetRowNodeDescriptor,
  replaceDataset: replaceDatasetNodeDescriptor,
  codeNew: codeNewNodeDescriptor,
  expression: expressionNodeDescriptor,
  jsFilter: jsFilterNodeDescriptor,
  jsMap: jsMapNodeDescriptor,
  extractObjectPath: extractObjectPathNodeDescriptor,
  httpCall: httpCallNodeDescriptor,
  prompt: promptNodeDescriptor,
  boolean: booleanNodeDescriptor,
  compare: compareNodeDescriptor,
  coalesce: coalesceNodeDescriptor,
  passthrough: passthroughNodeDescriptor,
  dataBus: dataBusNodeDescriptor,
  llmChatV2: llmChatV2NodeDescriptor,
  llmProfile: llmProfileNodeDescriptor,
};

export function useNodeTypes(): NodeComponentDescriptors {
  const counter = useAtomValue(pluginRefreshCounterState);
  const projectNodeRegistry = useProjectNodeRegistry();

  return useMemo(() => {
    if (Number.isNaN(counter)) {
      // just for rules-of-hooks
      throw new Error();
    }

    const allNodeTypes = projectNodeRegistry.getNodeTypes();

    return Object.fromEntries(
      allNodeTypes.map((nodeType) => {
        const descriptor = overriddenDescriptors[nodeType as BuiltInNodeType] ?? {};
        return [nodeType, descriptor];
      }),
    ) as NodeComponentDescriptors;
  }, [counter, projectNodeRegistry]);
}

export function useUnknownNodeComponentDescriptorFor(node: ChartNode) {
  const descriptors = useNodeTypes();

  return (descriptors[node.type as BuiltInNodeType] ?? {}) as UnknownNodeComponentDescriptor;
}
