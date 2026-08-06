import { getLLMChatV2BodySections, type LLMChatV2Node } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { LLMNodeBody } from './LLMNodeBody.js';

const LLMChatV2NodeBody: FC<{ node: LLMChatV2Node }> = ({ node }) => (
  <LLMNodeBody sections={getLLMChatV2BodySections(node.data)} />
);

export const llmChatV2NodeDescriptor: NodeComponentDescriptor<'llmChatV2'> = {
  Body: LLMChatV2NodeBody,
};
