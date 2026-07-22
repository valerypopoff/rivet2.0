import { type FC, useEffect, useRef } from 'react';
import { css } from '@emotion/react';
import { useTotalRunCost } from '../hooks/useTotalRunCost';
import { useAtomValue } from 'jotai';
import { graphRunningState, graphStartTimeState } from '../state/dataFlow';
import prettyMs from 'pretty-ms';

const styles = css`
  position: fixed;
  bottom: 8px;
  right: 8px;
  height: 32px;
  width: auto;
  background: var(--grey-darker);
  border-top: 1px solid var(--grey-dark);
  color: var(--grey-light);
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
`;

export const StatusBar: FC<{}> = () => {
  const cost = useTotalRunCost();
  const graphRunning = useAtomValue(graphRunningState);
  const graphStartTime = useAtomValue(graphStartTimeState);

  const runtimeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!graphRunning || graphStartTime == null) {
      return;
    }

    let animationFrameId: number | undefined;
    const updateRuntime = () => {
      const runtime = runtimeRef.current;
      if (runtime == null) {
        return;
      }

      runtime.innerText = prettyMs(Date.now() - graphStartTime, {
        keepDecimalsOnWholeSeconds: true,
        secondsDecimalDigits: 2,
      });
      animationFrameId = requestAnimationFrame(updateRuntime);
    };

    updateRuntime();
    return () => {
      if (animationFrameId != null) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [graphRunning, graphStartTime]);

  return (
    <div css={styles}>
      {(graphStartTime ?? 0) > 0 && (
        <div className="runtime">
          Runtime: <strong ref={runtimeRef}></strong>
        </div>
      )}
      {cost > 0 && (
        <div className="cost">
          Run Cost: <strong>${parseFloat(cost.toFixed(3)).toLocaleString()}</strong>
        </div>
      )}
    </div>
  );
};
