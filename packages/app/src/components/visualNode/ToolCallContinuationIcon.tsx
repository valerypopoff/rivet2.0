import type { FC } from 'react';

/**
 * Marks the Delegate Tool Call request/response loop: calls arrive from the
 * LLM above, then results travel back so the LLM can continue or call again.
 */
export const ToolCallContinuationIcon: FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3.5 7.5h14.7" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    <path d="m15.2 4.5 3 3-3 3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    <path d="M20.5 16.5H5.8" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    <path d="m8.8 13.5-3 3 3 3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
  </svg>
);
