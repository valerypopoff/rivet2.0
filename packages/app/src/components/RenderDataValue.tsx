import { type DataValue, type NodeOutputDefinition } from '@valerypopoff/rivet2-core';
import { keys } from '../utils/typeSafety.js';
import { type FC } from 'react';
import { type DataRefReader, useDataRefs } from '../providers/ProvidersContext.js';
import { type DataValueWithRefs, type InputsOrOutputsWithRefs } from '../state/dataFlow.js';
import {
  isPreviewOnlyStoredValue,
  isStoredInlineDataValue,
  isStoredRefDataValue,
  tryRestoreStoredDataValue,
} from '../utils/executionDataStorage.js';
import { createDataValueRendererMap } from './renderDataValue/createDataValueRendererMap.js';
import { createScalarRenderers } from './renderDataValue/createScalarRenderers.js';
import { LargeStoredValuePreview } from './renderDataValue/LargeStoredValuePreview.js';
import type { OutputRenderMode } from './renderDataValue/outputRenderTypes.js';
import { outputSectionLabelStyles, renderedDataOutputsStyles } from './renderDataValue/renderDataValueStyles.js';
import { isVisibleOutputPort } from '../utils/outputPortVisibility.js';

export type { OutputRenderMode } from './renderDataValue/outputRenderTypes.js';

let rendererMapSingleton: ReturnType<typeof createDataValueRendererMap> | undefined;

export function RenderDataValue({
  value,
  depth,
  renderMarkdown,
  truncateLength,
  isCompact,
  mode,
  allowLargeStoredValueActions,
  wrapLines,
}: {
  value: DataValueWithRefs | DataValue | undefined;
  depth?: number;
  renderMarkdown?: boolean;
  truncateLength?: number;
  isCompact?: boolean;
  mode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}) {
  const dataRefs = useDataRefs();
  const effectiveMode = mode ?? (isCompact ? 'compact' : 'full');
  const rendererMap = getRendererMap();

  if ((depth ?? 0) > 100) {
    return <>ERROR: FAILED TO RENDER {JSON.stringify(value)}</>;
  }

  if (!value) {
    return <>undefined</>;
  }

  if (isStoredRefDataValue(value) && isPreviewOnlyStoredValue(value)) {
    return (
      <LargeStoredValuePreview
        value={value}
        mode={effectiveMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  }

  const resolvedValue = toRenderableDataValue(value, dataRefs);
  if (!resolvedValue) {
    return <div>Value no longer available in memory.</div>;
  }

  const Renderer = rendererMap[resolvedValue.type];

  return (
    <Renderer
      value={resolvedValue}
      depth={depth}
      renderMarkdown={renderMarkdown}
      truncateLength={truncateLength}
      isCompact={isCompact}
      mode={effectiveMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  );
}

export const RenderDataOutputs: FC<{
  definitions?: NodeOutputDefinition[];
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown?: boolean;
  isCompact: boolean;
  mode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ definitions, outputs, renderMarkdown, isCompact, mode, allowLargeStoredValueActions, wrapLines }) => {
  const visibleOutputPorts = keys(outputs).filter((portId) => isVisibleOutputPort(portId) && outputs[portId] != null);
  const outputPorts = isCompact ? visibleOutputPorts.slice(0, 1) : visibleOutputPorts;
  const effectiveMode = mode ?? (isCompact ? 'compact' : 'full');

  if (outputPorts.length === 0) {
    return null;
  }

  if (outputPorts.length === 1) {
    return (
      <div>
        <RenderDataValue
          value={outputs[outputPorts[0]!]!}
          renderMarkdown={renderMarkdown}
          isCompact={isCompact}
          mode={effectiveMode}
          allowLargeStoredValueActions={allowLargeStoredValueActions}
          wrapLines={wrapLines}
        />
      </div>
    );
  }

  return (
    <div css={renderedDataOutputsStyles} className="rendered-data-outputs">
      {outputPorts.map((portId) => {
        const def = definitions?.find((d) => d.id === portId);
        const label = def?.title ?? portId;

        return (
          <div className="port-value" key={portId}>
            <div>
              <em css={outputSectionLabelStyles} className="port-id-label">
                {label}
              </em>
            </div>
            <RenderDataValue
              value={outputs[portId]!}
              renderMarkdown={renderMarkdown}
              isCompact={isCompact}
              mode={effectiveMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          </div>
        );
      })}
    </div>
  );
};

function getRendererMap(): ReturnType<typeof createDataValueRendererMap> {
  if (!rendererMapSingleton) {
    const renderValue = (nestedProps: {
      value: DataValue | undefined;
      depth?: number;
      renderMarkdown?: boolean;
      truncateLength?: number;
      isCompact?: boolean;
      mode?: OutputRenderMode;
      allowLargeStoredValueActions?: boolean;
      wrapLines?: boolean;
    }) => <RenderDataValue {...nestedProps} />;

    const scalarRenderers = createScalarRenderers({
      renderValue,
    });

    rendererMapSingleton = createDataValueRendererMap({
      scalarRenderers,
      renderValue,
    });
  }

  return rendererMapSingleton;
}

function toRenderableDataValue(value: DataValueWithRefs | DataValue, dataRefs: DataRefReader): DataValue | undefined {
  if (isStoredInlineDataValue(value)) {
    return {
      type: value.type,
      value: value.value,
    } as DataValue;
  }

  if (isStoredRefDataValue(value)) {
    return tryRestoreStoredDataValue(value, dataRefs);
  }

  return value as DataValue;
}
