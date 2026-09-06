import { css } from '@emotion/react';
import { useMemo, type FC } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { currentGraphViewState, graphRunHistoryByViewState, selectedGraphRunByViewState } from '../state/dataFlow';
import { getGraphRunsForView, getSelectedGraphRunId } from '../state/selectors/executionSelectors.js';
import LeftIcon from 'majesticons/line/chevron-left-line.svg?react';
import RightIcon from 'majesticons/line/chevron-right-line.svg?react';
import { Tooltip } from './Tooltip';

const styles = css`
  --action-bar-height: calc(32px * var(--ui-font-scale));

  position: fixed;
  top: calc(20px + var(--project-selector-height) + var(--data-bus-full-row-height, 0px));
  left: 50%;
  transform: translateX(-50%);
  background: var(--grey-darker);
  border-radius: 12px;
  corner-shape: squircle;
  @supports not (corner-shape: squircle) {
    border-radius: 6px;
  }
  border: 1px solid var(--grey-darkish);
  height: var(--action-bar-height);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.4);
  user-select: none;

  .current {
    display: flex;
    align-items: center;
    justify-content: center;
    height: calc(var(--action-bar-height) - 2px);
    min-width: 32px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-base);
    font-weight: 500;
    pointer-events: none;
    line-height: 1;
    padding: 0 4px;
  }

  button {
    background: none;
    border: none;
    color: var(--grey-light);
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(var(--action-bar-height) - 2px);
    height: calc(var(--action-bar-height) - 2px);
    padding: 0;
    cursor: pointer;
    transition:
      color 0.2s ease-out,
      background 0.2s ease-out;
    border-radius: var(--ui-button-radius-sm);
    corner-shape: squircle;

    svg {
      width: 16px;
      height: 16px;
    }

    &:hover {
      color: var(--grey-lighter);
      background: var(--grey-darkish);
    }

    &:disabled {
      color: var(--grey-dark);
      cursor: default;
    }
  }
`;

export const GraphExecutionSelectorBar: FC = () => {
  const currentGraphView = useAtomValue(currentGraphViewState);
  const graphRunHistoryByView = useAtomValue(graphRunHistoryByViewState);
  const [selectedGraphRunByView, setSelectedGraphRunByView] = useAtom(selectedGraphRunByViewState);

  const graphRuns = useMemo(
    () => getGraphRunsForView({ currentGraphView, graphRunHistoryByView }),
    [currentGraphView, graphRunHistoryByView],
  );

  const selectedGraphRun = currentGraphView ? selectedGraphRunByView[currentGraphView.key] ?? 'latest' : 'latest';

  const selectedExecutionIndex = useMemo(() => {
    const selectedId = getSelectedGraphRunId(graphRuns, selectedGraphRun);
    return graphRuns.findIndex((graphRun) => graphRun.graphRunId === selectedId);
  }, [graphRuns, selectedGraphRun]);
  const hasNoCallerExecution = typeof selectedGraphRun === 'object' && selectedExecutionIndex === -1;

  const setSelectedGraphRun = (graphRunId: typeof selectedGraphRun) => {
    if (!currentGraphView) {
      return;
    }

    setSelectedGraphRunByView((prev) => ({
      ...prev,
      [currentGraphView.key]: graphRunId,
    }));
  };

  const onPrev = () => {
    if (selectedExecutionIndex <= 0) {
      return;
    }

    setSelectedGraphRun(graphRuns[selectedExecutionIndex - 1]!.graphRunId);
  };

  const onNext = () => {
    if (!graphRuns.length || selectedExecutionIndex === graphRuns.length - 1) {
      return;
    }

    if (selectedExecutionIndex === graphRuns.length - 2) {
      setSelectedGraphRun('latest');
    } else {
      setSelectedGraphRun(graphRuns[selectedExecutionIndex + 1]!.graphRunId);
    }
  };

  const selectedExecutionFraction =
    selectedExecutionIndex === -1 ? '0/0' : `${selectedExecutionIndex + 1}/${graphRuns.length}`;
  const selectedExecutionLabel = hasNoCallerExecution
    ? 'No execution for selected caller'
    : `Execution: ${selectedExecutionFraction}`;

  if (!currentGraphView || (graphRuns.length <= 1 && !hasNoCallerExecution)) {
    return null;
  }

  return (
    <div css={styles}>
      <Tooltip content="Previous execution (all nodes)" placement="bottom">
        <button
          className="prev"
          aria-label="Previous execution (all nodes)"
          disabled={selectedExecutionIndex <= 0}
          onClick={onPrev}
        >
          <LeftIcon />
        </button>
      </Tooltip>
      <Tooltip
        content={
          hasNoCallerExecution
            ? 'The selected caller has no child execution. Other recorded invocations remain available using the arrows.'
            : `This graph view has executed ${graphRuns.length} times. You are viewing ${selectedExecutionLabel.toLowerCase()}.`
        }
        placement="bottom"
      >
        <div className="current">{selectedExecutionLabel}</div>
      </Tooltip>
      <Tooltip content="Next execution (all nodes)" placement="bottom">
        <button
          className="next"
          aria-label="Next execution (all nodes)"
          disabled={selectedExecutionIndex >= graphRuns.length - 1}
          onClick={onNext}
        >
          <RightIcon />
        </button>
      </Tooltip>
    </div>
  );
};
