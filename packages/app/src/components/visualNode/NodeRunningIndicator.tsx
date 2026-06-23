import { css } from '@emotion/react';
import { memo, useEffect, useState } from 'react';

export const NODE_RUNNING_INDICATOR_DELAY_MS = 500;

const nodeRunningIndicatorStyles = css`
  box-sizing: border-box;
  color: currentColor;
  display: inline-block;
  width: calc(16px * var(--ui-font-scale));
  height: calc(16px * var(--ui-font-scale));
  border: calc(2px * var(--ui-font-scale)) solid currentColor;
  border-right-color: transparent;
  border-bottom-color: transparent;
  border-radius: 50%;
  flex: 0 0 auto;
  pointer-events: none;
  animation: node-running-indicator-spin 0.8s linear infinite;

  @keyframes node-running-indicator-spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

export function useDelayedRunningState(isRunning: boolean, delayMs = NODE_RUNNING_INDICATOR_DELAY_MS): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isRunning) {
      setVisible(false);
      return;
    }

    if (delayMs <= 0) {
      setVisible(true);
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      setVisible(true);
    }, delayMs);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [delayMs, isRunning]);

  return visible;
}

export const NodeRunningIndicator = memo(
  ({
    isRunning,
    delayMs = NODE_RUNNING_INDICATOR_DELAY_MS,
    label = 'Node running',
  }: {
    isRunning: boolean;
    delayMs?: number;
    label?: string;
  }) => {
    const visible = useDelayedRunningState(isRunning, delayMs);

    if (!visible) {
      return null;
    }

    return <span className="node-running-indicator" css={nodeRunningIndicatorStyles} aria-label={label} role="status" />;
  },
);

NodeRunningIndicator.displayName = 'NodeRunningIndicator';
