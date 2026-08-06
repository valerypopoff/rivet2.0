import { getLLMProfileBodySections, type LLMProfileNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { LLMNodeBody } from './LLMNodeBody.js';

const LLMProfileNodeBody: FC<{ node: LLMProfileNode }> = ({ node }) => (
  <LLMNodeBody sections={getLLMProfileBodySections(node.data)} />
);

export const llmProfileNodeDescriptor: NodeComponentDescriptor<'llmProfile'> = {
  Body: LLMProfileNodeBody,
};
