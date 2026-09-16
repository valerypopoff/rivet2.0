import { type MatchCaseNode, type MatchNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { LLMNodeBody } from './LLMNodeBody.js';

function getTriggerSummary(
  exclusive: boolean | undefined,
  defaultExclusive: boolean,
  firstMatchingCaseLabel = 'First matching case',
): string {
  return (exclusive ?? defaultExclusive) ? firstMatchingCaseLabel : 'All matching cases';
}

function getReturnValueSummary(returnValue: MatchCaseNode['data']['returnValue']): string {
  if (returnValue === 'testValue') {
    return 'Input value';
  }

  if (returnValue === 'custom') {
    return 'Custom';
  }

  return 'true';
}

const MatchNodeBody: FC<{ node: MatchNode }> = ({ node }) => (
  <LLMNodeBody
    sections={[
      {
        id: 'trigger',
        fields: [
          {
            label: 'Trigger',
            value: getTriggerSummary(node.data.exclusive, false, 'First matching case only'),
          },
        ],
      },
    ]}
  />
);

export const matchNodeDescriptor: NodeComponentDescriptor<'match'> = {
  Body: MatchNodeBody,
};

const MatchCaseNodeBody: FC<{ node: MatchCaseNode }> = ({ node }) => (
  <LLMNodeBody
    sections={[
      {
        id: 'match',
        fields: [
          {
            label: 'Match mode',
            value: node.data.matchMode === 'regex' ? 'Regular expression' : 'Plain text',
          },
          ...(node.data.matchMode === 'regex'
            ? []
            : [
                {
                  label: 'Case sensitive',
                  value: node.data.caseSensitive === false ? 'No' : 'Yes',
                },
              ]),
        ],
      },
      {
        id: 'trigger',
        fields: [
          {
            label: 'Trigger',
            value: getTriggerSummary(node.data.exclusive, true),
          },
        ],
      },
      {
        id: 'value',
        fields: [
          {
            label: 'Output value',
            value: getReturnValueSummary(node.data.returnValue),
            valueIsCode: node.data.returnValue !== 'testValue' && node.data.returnValue !== 'custom',
          },
        ],
      },
    ]}
  />
);

export const matchCaseNodeDescriptor: NodeComponentDescriptor<'matchCase'> = {
  Body: MatchCaseNodeBody,
};
