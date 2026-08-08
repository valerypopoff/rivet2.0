import type { FC } from 'react';
import { Tooltip } from '../Tooltip.js';
import { ToolCallContinuationIcon } from './ToolCallContinuationIcon.js';

/** Canvas-only explanation of Delegate Tool Call's request/response lifecycle. */
export const ToolCallContinuationIndicator: FC = () => (
  <Tooltip
    className="tool-call-continuation-tooltip"
    content="Tool calls arrive from the LLM and their results return to it, so it can continue or invoke more tools."
    tag="span"
    wrap
    width={260}
  >
    <span className="tool-call-continuation-indicator" role="img" aria-label="Tool calls return results to the LLM">
      <ToolCallContinuationIcon />
    </span>
  </Tooltip>
);
