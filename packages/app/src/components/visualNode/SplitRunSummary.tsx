import { DEFAULT_SPLIT_RUN_CONCURRENCY, type ChartNode } from '@valerypopoff/rivet2-core';
import { type FC, type MouseEvent, type PointerEvent } from 'react';
import { Tooltip } from '../Tooltip.js';
import { useCanvasHandlersContext } from '../CanvasContext.js';
import { SplitRunModeIcon } from './SplitRunModeIcon.js';

export const SplitRunSummary: FC<{
  node: ChartNode;
  editTargetNode?: ChartNode;
  isKnownNodeType: boolean;
}> = ({ node, editTargetNode, isKnownNodeType }) => {
  const { onNodeStartEditing } = useCanvasHandlersContext();

  if (!node.isSplitRun) {
    return null;
  }

  const splitRunModeLabel = node.isSplitSequential ? 'sequential' : 'parallel';
  const splitRunMaxLabel = `max ${node.splitRunMax ?? 10}`;
  const splitRunConcurrencyLabel = node.isSplitSequential
    ? undefined
    : `conc ${node.splitRunConcurrency ?? DEFAULT_SPLIT_RUN_CONCURRENCY}`;
  const splitRunDetailsLabel = splitRunConcurrencyLabel
    ? `${splitRunMaxLabel}, ${splitRunConcurrencyLabel}`
    : splitRunMaxLabel;

  return (
    <Tooltip className="split-run-summary-tooltip" content="Edit Node" placement="top" tag="span">
      <button
        type="button"
        className="split-run-summary"
        aria-label={`Edit split run settings, ${splitRunModeLabel}, ${splitRunDetailsLabel}`}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          if (isKnownNodeType) {
            onNodeStartEditing?.(editTargetNode ?? node);
          }
        }}
        onMouseDown={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          event.preventDefault();
        }}
        onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
          event.stopPropagation();
        }}
      >
        <SplitRunModeIcon isSequential={node.isSplitSequential} />
        <span className="split-run-summary-text">
          <strong className="split-run-summary-mode">{splitRunModeLabel}</strong>
          {`, ${splitRunDetailsLabel}`}
        </span>
      </button>
    </Tooltip>
  );
};
