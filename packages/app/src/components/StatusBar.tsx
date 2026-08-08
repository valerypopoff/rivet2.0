import { type FC, useEffect, useState } from 'react';
import { css } from '@emotion/react';
import { useTotalRunCost } from '../hooks/useTotalRunCost';
import { useAtom, useAtomValue } from 'jotai';
import { graphRunningState, graphStartTimeState, runActivityJournalState } from '../state/dataFlow';
import { runActivityDrawerOpenState } from '../state/ui.js';
import { resolveRuntimeStatusTiming } from './runtimeStatus.js';
import { formatRunActivityDuration } from '../utils/runActivityDuration.js';

const styles = css`
  position: fixed;
  bottom: calc(8px + var(--run-activity-drawer-reserved-height, 0px));
  right: 8px;
  height: 32px;
  width: auto;
  background: var(--modal-surface-bg);
  border: 1px solid var(--app-panel-border);
  color: var(--foreground-dim);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8px;
  z-index: 50;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
  gap: 16px;
  font-size: var(--ui-font-size-sm);
  border-radius: 10px;
  corner-shape: squircle;
  @supports not (corner-shape: squircle) {
    border-radius: 5px;
  }

  .runtime {
    height: 100%;
    margin: 0;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .runtime:hover {
    color: var(--foreground);
  }

  .runtime:focus-visible {
    border-radius: var(--ui-button-radius-sm, 6px);
    outline: 1px solid var(--primary);
    outline-offset: -2px;
  }

  @media (max-width: 720px) {
    bottom: 8px;
  }
`;

export const StatusBar: FC<{}> = () => {
  const cost = useTotalRunCost();
  const graphRunning = useAtomValue(graphRunningState);
  const graphStartTime = useAtomValue(graphStartTimeState);
  const runActivityJournal = useAtomValue(runActivityJournalState);
  const [runActivityOpen, setRunActivityOpen] = useAtom(runActivityDrawerOpenState);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const runtimeTiming = resolveRuntimeStatusTiming({
    graphRunning,
    graphStartTime,
    journal: runActivityJournal,
    now: currentTime,
  });

  useEffect(() => {
    if (!runtimeTiming.isLive) {
      return;
    }

    let animationFrameId: number | undefined;
    const updateRuntime = () => {
      setCurrentTime(Date.now());
      animationFrameId = requestAnimationFrame(updateRuntime);
    };

    updateRuntime();
    return () => {
      if (animationFrameId != null) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [runtimeTiming.isLive, runtimeTiming.startedAt]);

  return (
    <div css={styles}>
      <button
        type="button"
        className="runtime"
        aria-label={runActivityOpen ? 'Close Run Activity' : 'Open Run Activity'}
        aria-pressed={runActivityOpen}
        title={runActivityOpen ? 'Close Run Activity' : 'Open Run Activity'}
        onClick={() => setRunActivityOpen((current) => !current)}
      >
        Run activity
        {runtimeTiming.elapsedMs != null && (
          <>
            : <strong>{formatRunActivityDuration(runtimeTiming.elapsedMs)}</strong>
          </>
        )}
      </button>
      {cost > 0 && (
        <div className="cost">
          Run Cost: <strong>${parseFloat(cost.toFixed(3)).toLocaleString()}</strong>
        </div>
      )}
    </div>
  );
};
