import { type MatchNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { LLMNodeBody } from './LLMNodeBody.js';

const MatchNodeBody: FC<{ node: MatchNode }> = ({ node }) => (
  <LLMNodeBody
    sections={[
      {
        id: 'trigger',
        fields: [
          {
            label: 'Trigger',
            value: node.data.exclusive ? 'First matching case only' : 'All matching cases',
          },
        ],
      },
    ]}
  />
);

export const matchNodeDescriptor: NodeComponentDescriptor<'match'> = {
  Body: MatchNodeBody,
};
