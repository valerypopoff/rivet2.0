import { type ChartNode } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { ToolCallContinuationIndicator } from './ToolCallContinuationIndicator.js';

const GlobalNodeTitleIcon: FC<{ direction: 'get' | 'set' }> = ({ direction }) => (
  <svg
    className={`global-node-title-icon global-node-title-icon-${direction}`}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    {direction === 'get' ? (
      <>
        <path d="M12 20V7" />
        <path d="m7.5 11.5 4.5-4.5 4.5 4.5" />
        <path d="M7 20h10" />
      </>
    ) : (
      <>
        <path d="M12 6v11" />
        <path d="m7.5 12.5 4.5 4.5 4.5-4.5" />
        <path d="M7 20h10" />
      </>
    )}
  </svg>
);

const knowledgeNodeTypes = new Set([
  'knowledgeSource',
  'knowledgeDocument',
  'syncKnowledgeSource',
  'getKnowledgeSourceStatus',
  'searchKnowledge',
  'buildKnowledgeContext',
]);

const KnowledgeNodeTitleIcon: FC = () => (
  <svg className="knowledge-node-title-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <ellipse cx="12" cy="5.5" rx="7.5" ry="3.5" />
    <path d="M4.5 5.5v6.5c0 1.9 3.36 3.5 7.5 3.5s7.5-1.6 7.5-3.5V5.5" />
    <path d="M4.5 12v6.5C4.5 20.4 7.86 22 12 22s7.5-1.6 7.5-3.5V12" />
  </svg>
);

export const NodeTitleLabel: FC<{ node: Pick<ChartNode, 'title' | 'type'> }> = ({ node }) => {
  const globalIconDirection =
    node.type === 'getGlobal' || node.type === 'getStoredValue'
      ? 'get'
      : node.type === 'setGlobal' || node.type === 'setStoredValue'
        ? 'set'
        : undefined;
  const hasKnowledgeIcon = knowledgeNodeTypes.has(node.type);
  const hasToolCallContinuationIcon = node.type === 'delegateFunctionCall';

  return (
    <span className="title-text-label">
      {globalIconDirection && <GlobalNodeTitleIcon direction={globalIconDirection} />}
      {hasKnowledgeIcon && <KnowledgeNodeTitleIcon />}
      {hasToolCallContinuationIcon && <ToolCallContinuationIndicator />}
      {node.title}
    </span>
  );
};
