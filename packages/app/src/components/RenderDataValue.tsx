import { type DataValue } from '@valerypopoff/rivet2-core';
import { type DataRefReader, useDataRefs } from '../providers/ProvidersContext.js';
import { type DataValueWithRefs } from '../state/dataFlow.js';
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

  const Renderer = rendererMap.get(resolvedValue.type);

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
