import {
  getClassifierEvaluateBodySections,
  getClassifierQuestionBodySections,
  type ClassifierEvaluateNode,
  type ClassifierQuestionNode,
  type ClassifierProfileNode,
} from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { LLMNodeBody } from './LLMNodeBody.js';

const ClassifierQuestionNodeBody: FC<{ node: ClassifierQuestionNode }> = ({ node }) => (
  <LLMNodeBody sections={getClassifierQuestionBodySections(node.data)} />
);

const ClassifierEvaluateNodeBody: FC<{ node: ClassifierEvaluateNode }> = ({ node }) => (
  <LLMNodeBody sections={getClassifierEvaluateBodySections(node.data)} />
);

export const classifierQuestionNodeDescriptor: NodeComponentDescriptor<'classifierQuestion'> = {
  Body: ClassifierQuestionNodeBody,
};

export const classifierEvaluateNodeDescriptor: NodeComponentDescriptor<'classifierEvaluate'> = {
  Body: ClassifierEvaluateNodeBody,
};
export const classifierProfileNodeDescriptor: NodeComponentDescriptor<'classifierProfile'> = {
  Body: ({ node }: { node: ClassifierProfileNode }) => (
    <LLMNodeBody
      sections={[
        ...getClassifierEvaluateBodySections({ ...node.data, errorOnNon200: false }),
        {
          id: 'suspension',
          fields: [{ label: 'Automatic suspension', value: node.data.enableCircuitBreaker ? 'Enabled' : 'Disabled' }],
        },
      ]}
    />
  ),
};
