import { css } from '@emotion/react';
import {
  type FC,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAtomValue } from 'jotai';
import { projectState } from '../../state/savedGraphs.js';
import { type GraphId, type PortId, type SubGraphNode } from '@valerypopoff/rivet2-core';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { RenderDataOutputs, type OutputRenderMode } from '../RenderDataValue.js';
import { omit } from 'lodash-es';
import { type InputsOrOutputsWithRefs } from '../../state/dataFlow';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { tryRestoreStoredDataValue } from '../../utils/executionDataStorage.js';
import { getSubGraphNodeCopyValueData } from '../../utils/nodeOutputCopyValueProjectors.js';
import {
  formatSubGraphCost,
  formatSubGraphDurationMs,
  getSubGraphCostMetric,
  getSubGraphDurationMetric,
  type SubGraphNumberMetric,
} from '../../utils/subGraphOutputMetrics.js';
import { hasVisibleStoredPortMapValues } from '../../utils/outputPortVisibility.js';
import { useEditNodeCommand } from '../../commands/editNodeCommand.js';
import { getProjectGraphSelectorOptions } from '../../utils/graphSelectorOptions.js';

const subGraphBodyCss = css`
  color: var(--foreground-bright);
  font-family: var(--font-family-monospace);
  font-size: var(--ui-font-size-sm);
  line-height: 1.2;
  max-width: 100%;
  min-width: 0;
  user-select: none;

  .subgraph-node-body-select-wrap {
    align-items: center;
    color: var(--foreground-bright);
    display: flex;
    max-width: 100%;
    min-width: 0;
    position: relative;
    width: 100%;
  }

  .subgraph-node-body-select-wrap::after {
    border-left: calc(4px * var(--ui-font-scale, 1)) solid transparent;
    border-right: calc(4px * var(--ui-font-scale, 1)) solid transparent;
    border-top: calc(5px * var(--ui-font-scale, 1)) solid currentColor;
    content: '';
    pointer-events: none;
    position: absolute;
    right: calc(8px * var(--ui-font-scale, 1));
  }

  .subgraph-node-body-select {
    align-items: center;
    appearance: none;
    background: var(--node-body-bg);
    border: 1px solid color-mix(in srgb, var(--foreground-bright) 18%, transparent);
    border-radius: calc(5px * var(--ui-font-scale, 1));
    color: var(--foreground-bright);
    cursor: pointer;
    display: flex;
    font: inherit;
    height: calc(30px * var(--ui-font-scale, 1));
    line-height: 1.2;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    padding: 0 calc(24px * var(--ui-font-scale, 1)) 0 calc(8px * var(--ui-font-scale, 1));
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  .subgraph-node-body-select:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .subgraph-node-body-select:focus-visible {
    border-color: var(--primary);
    outline: none;
  }

  .subgraph-node-body-select-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subgraph-node-body-select-menu {
    background: var(--node-body-bg);
    border: 1px solid color-mix(in srgb, var(--foreground-bright) 20%, transparent);
    border-radius: calc(6px * var(--ui-font-scale, 1));
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    left: 0;
    max-height: calc(180px * var(--ui-font-scale, 1));
    min-width: 100%;
    overflow-y: auto;
    padding: calc(3px * var(--ui-font-scale, 1));
    position: absolute;
    top: calc(100% + 4px);
    z-index: 1000;
  }

  .subgraph-node-body-select-option {
    appearance: none;
    background: var(--node-body-bg);
    border: none;
    border-radius: calc(4px * var(--ui-font-scale, 1));
    color: var(--foreground-bright);
    cursor: pointer;
    font: inherit;
    line-height: 1.2;
    max-width: 100%;
    min-height: calc(24px * var(--ui-font-scale, 1));
    overflow: hidden;
    padding: calc(5px * var(--ui-font-scale, 1)) calc(7px * var(--ui-font-scale, 1));
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subgraph-node-body-select-option:hover,
  .subgraph-node-body-select-option:focus-visible,
  .subgraph-node-body-select-option.selected {
    background: color-mix(in srgb, var(--primary) 18%, var(--node-body-bg) 82%);
    outline: none;
  }
`;

const subGraphOutputCss = css`
  .metaInfo.with-body {
    margin-bottom: 8px;
  }
`;

export const SubGraphNodeBody: FC<{
  node: SubGraphNode;
}> = ({ node }) => {
  const project = useAtomValue(projectState);
  const editNode = useEditNodeCommand();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const graphOptions = useMemo(
    () =>
      getProjectGraphSelectorOptions(project.graphs, {
        includeMissingSelectedGraph: true,
        selectedGraphId: node.data.graphId,
      }),
    [node.data.graphId, project.graphs],
  );
  const selectedOption = graphOptions.find((option) => option.value === node.data.graphId);
  const selectedLabel = selectedOption?.label ?? (graphOptions.length === 0 ? 'No graphs' : 'Select graph...');

  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }

      closeMenu();
    };

    const handleDocumentWheel = (event: WheelEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) {
        return;
      }

      closeMenu();
    };

    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    document.addEventListener('wheel', handleDocumentWheel, true);
    document.addEventListener('keydown', handleDocumentKeyDown, true);

    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('wheel', handleDocumentWheel, true);
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [closeMenu, isMenuOpen]);

  const handleSelectGraph = (graphId: GraphId) => {
    setIsMenuOpen(false);

    if (!graphId || graphId === node.data.graphId) {
      return;
    }

    editNode({
      nodeId: node.id,
      newNode: {
        data: {
          ...node.data,
          graphId,
        },
      },
    });
  };

  const handleControlMouseDown = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const handleControlDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleControlKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setIsMenuOpen(false);
    }
  };

  const handleMenuWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleControlWheel = (event: ReactWheelEvent<HTMLButtonElement>) => {
    if (!isMenuOpen) {
      return;
    }

    event.stopPropagation();
    setIsMenuOpen(false);
  };

  return (
    <div ref={rootRef} css={subGraphBodyCss} onDoubleClick={handleControlDoubleClick}>
      <div className="subgraph-node-body-select-wrap">
        <button
          aria-controls={isMenuOpen ? menuId : undefined}
          aria-label="Subgraph graph"
          aria-expanded={isMenuOpen}
          aria-haspopup="listbox"
          className="subgraph-node-body-select"
          disabled={graphOptions.length === 0}
          onClick={() => setIsMenuOpen((open) => !open)}
          onKeyDown={handleControlKeyDown}
          onMouseDown={handleControlMouseDown}
          onWheel={handleControlWheel}
          type="button"
        >
          <span className="subgraph-node-body-select-label">{selectedLabel}</span>
        </button>
        {isMenuOpen && (
          <div
            id={menuId}
            className="subgraph-node-body-select-menu"
            role="listbox"
            aria-label="Subgraph graph options"
            onWheel={handleMenuWheel}
          >
            {graphOptions.map((option) => (
              <button
                key={option.value}
                className={`subgraph-node-body-select-option${option.value === node.data.graphId ? ' selected' : ''}`}
                onClick={() => handleSelectGraph(option.value)}
                onMouseDown={handleControlMouseDown}
                role="option"
                aria-selected={option.value === node.data.graphId}
                title={option.label}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export const SubGraphNodeOutputSimple: FC<{
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown?: boolean;
  isCompact: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ outputs, renderMarkdown, isCompact, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const dataRefs = useDataRefs();
  const costMetric = getSubGraphCostMetric(tryRestoreStoredDataValue(outputs['cost' as PortId], dataRefs));
  const durationMetric = getSubGraphDurationMetric(
    tryRestoreStoredDataValue(outputs['duration' as PortId], dataRefs),
  );
  const bodyOutputs = omit(outputs, ['cost', 'duration'])! as InputsOrOutputsWithRefs;
  const hasMeta = costMetric.kind !== 'none' || durationMetric.kind !== 'none';
  const hasBody = hasVisibleStoredPortMapValues(bodyOutputs);

  return (
    <div css={subGraphOutputCss}>
      {hasMeta && (
        <div className={hasBody ? 'metaInfo with-body' : 'metaInfo'}>
          <SubGraphNumberMetricMeta
            metric={costMetric}
            label="Cost"
            totalLabel="Total cost"
            formatValue={formatSubGraphCost}
          />
          <SubGraphNumberMetricMeta
            metric={durationMetric}
            label="Duration"
            totalLabel="Total duration"
            formatValue={formatSubGraphDurationMs}
          />
        </div>
      )}
      {hasBody && (
        <div>
          <RenderDataOutputs
            outputs={bodyOutputs}
            renderMarkdown={renderMarkdown}
            isCompact={isCompact}
            mode={renderMode}
            allowLargeStoredValueActions={allowLargeStoredValueActions}
            wrapLines={wrapLines}
          />
        </div>
      )}
    </div>
  );
};

const SubGraphNumberMetricMeta: FC<{
  metric: SubGraphNumberMetric;
  label: string;
  totalLabel: string;
  formatValue(value: number): string;
}> = ({ metric, label, totalLabel, formatValue }) => {
  if (metric.kind === 'none') {
    return null;
  }

  if (metric.kind === 'single') {
    return (
      <div>
        <em>
          {label}: {formatValue(metric.value)}
        </em>
      </div>
    );
  }

  return (
    <div>
      <div>
        <em>
          {totalLabel}: {formatValue(metric.totalValue)}
        </em>
      </div>
      {metric.runValues.map((value, index) => (
        <div key={index}>
          <em>
            Run {index + 1}: {formatValue(value)}
          </em>
        </div>
      ))}
    </div>
  );
};

export const FullscreenSubGraphNodeOutputSimple: FC<{
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ outputs, renderMarkdown, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  return (
    <SubGraphNodeOutputSimple
      outputs={outputs}
      renderMarkdown={renderMarkdown}
      isCompact={false}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  );
};

export const subgraphNodeDescriptor: NodeComponentDescriptor<'subGraph'> = {
  Body: SubGraphNodeBody,
  OutputSimple: SubGraphNodeOutputSimple,
  FullscreenOutputSimple: FullscreenSubGraphNodeOutputSimple,
  getCopyValueData: getSubGraphNodeCopyValueData,
};
