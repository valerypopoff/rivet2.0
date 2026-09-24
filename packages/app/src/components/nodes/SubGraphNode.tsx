import { css } from '@emotion/react';
import {
  type FC,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { type PortId, type SubGraphNode } from '@valerypopoff/rivet2-core';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { type OutputRenderMode } from '../RenderDataValue.js';
import { RenderDataOutputs } from '../nodeOutput/RenderDataOutputs.js';
import { isEqual, omit } from 'lodash-es';
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
import { SubgraphTargetControl } from './SubgraphTargetControl.js';

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
    /* Keep the menu above the node's ports, output controls, and frame overlay. */
    z-index: 11;
  }

  .subgraph-node-body-select {
    max-width: 100%;
    min-width: 0;
    width: 100%;
  }

  .subgraph-node-body-setting {
    margin-top: calc(8px * var(--ui-font-scale, 1));
    overflow: hidden;
    padding: 0 calc(8px * var(--ui-font-scale, 1));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subgraph-node-body-setting-label {
    opacity: 0.55;
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
  const editNode = useEditNodeCommand();

  const handleSelectGraph = (next: SubGraphNode) => {
    // Re-selecting the same target can accept a changed saved boundary. Only
    // ignore a selection when the complete authored node data is unchanged.
    if (isEqual(next.data, node.data)) {
      return;
    }

    editNode({
      nodeId: node.id,
      newNode: {
        data: next.data,
      },
    });
  };

  const handleControlMouseDown = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const handleControlPointerDown = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const handleControlDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleControlKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const handleMenuWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  return (
    <div css={subGraphBodyCss} onDoubleClick={handleControlDoubleClick}>
      <div
        className="subgraph-node-body-select-wrap"
        data-canvas-focus-preserve
        onKeyDown={handleControlKeyDown}
        onMouseDown={handleControlMouseDown}
        onPointerDown={handleControlPointerDown}
        onWheel={handleMenuWheel}
      >
        <SubgraphTargetControl node={node} onChange={handleSelectGraph} />
      </div>
      {node.data.skipUnusedOutputs === true && (
        <div className="subgraph-node-body-setting" data-testid="subgraph-skip-unused-outputs">
          <span className="subgraph-node-body-setting-label">Skip unused outputs:</span> Enabled
        </div>
      )}
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
  const durationMetric = getSubGraphDurationMetric(tryRestoreStoredDataValue(outputs['duration' as PortId], dataRefs));
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
