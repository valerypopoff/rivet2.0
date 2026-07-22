import { type ChartNode } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';

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

export const NodeTitleLabel: FC<{ node: Pick<ChartNode, 'title' | 'type'> }> = ({ node }) => {
  const globalIconDirection =
    node.type === 'getGlobal' || node.type === 'getStoredValue'
      ? 'get'
      : node.type === 'setGlobal' || node.type === 'setStoredValue'
        ? 'set'
        : undefined;

  return (
    <span className="title-text-label">
      {globalIconDirection && <GlobalNodeTitleIcon direction={globalIconDirection} />}
      {node.title}
    </span>
  );
};
