import {
  inferType,
  type DataValue,
  type DataType,
  type ScalarDataValue,
} from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../../providers/ProvidersContext.js';
import type { DataValueWithRefs } from '../../state/dataFlow.js';
import {
  isPreviewOnlyStoredValue,
  isStoredInlineDataValue,
  isStoredRefDataValue,
  tryRestoreStoredDataValue,
} from '../../utils/executionDataStorage.js';
import {
  stringifyAnyJsonLikeForDisplay,
  stringifyForDisplay,
  stringifyUninferredAnyValue,
} from '../../utils/dataValuePayloads.js';
import { getTextEditorStats, type TextEditorStats } from '../editors/textEditorStats.js';
import type { OutputRenderMode } from './outputRenderTypes.js';

const NON_TEXTUAL_OUTPUT_TYPES = new Set<DataType>([
  'audio',
  'audio[]',
  'binary',
  'binary[]',
  'document',
  'document[]',
  'image',
  'image[]',
]);

export function shouldShowOutputSectionStats({
  mode,
  allowLargeStoredValueActions,
}: {
  mode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
}): boolean {
  return mode === 'expanded-preview' && allowLargeStoredValueActions === true;
}

export function getOutputSectionStatsFromText(text: string | undefined): TextEditorStats | undefined {
  return text === undefined ? undefined : getTextEditorStats(text);
}

export function getOutputSectionStatsForValue(
  value: DataValueWithRefs | DataValue | undefined,
  dataRefs: DataRefReader,
): TextEditorStats | undefined {
  return getOutputSectionStatsFromText(getOutputSectionTextForValue(value, dataRefs));
}

function getOutputSectionTextForValue(
  value: DataValueWithRefs | DataValue | undefined,
  dataRefs: DataRefReader,
): string | undefined {
  if (!value || (isStoredRefDataValue(value) && isPreviewOnlyStoredValue(value))) {
    return undefined;
  }

  const renderableValue = toRenderableDataValue(value, dataRefs);
  return renderableValue ? getOutputSectionTextForRenderableValue(renderableValue) : undefined;
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

function getOutputSectionTextForRenderableValue(value: DataValue): string | undefined {
  if (NON_TEXTUAL_OUTPUT_TYPES.has(value.type)) {
    return undefined;
  }

  if (value.type.endsWith('[]')) {
    return stringifyForDisplay(value.value);
  }

  return getOutputSectionTextForScalarValue(value as ScalarDataValue);
}

function getOutputSectionTextForScalarValue(value: ScalarDataValue): string | undefined {
  switch (value.type) {
    case 'string':
    case 'date':
    case 'time':
    case 'datetime':
      return String(value.value);
    case 'boolean':
    case 'number':
      return String(value.value);
    case 'object':
    case 'chat-message':
      return stringifyForDisplay(value.value);
    case 'any': {
      const inferred = inferType(value.value);
      if (inferred.type === 'any') {
        return stringifyUninferredAnyValue(inferred.value);
      }
      if (inferred.type === 'object' || inferred.type.endsWith('[]')) {
        return stringifyAnyJsonLikeForDisplay(inferred.value);
      }
      return getOutputSectionTextForRenderableValue(inferred);
    }
    case 'control-flow-excluded':
      return 'Not ran';
    case 'gpt-function':
    case 'graph-reference':
      return stringifyForDisplay(value.value);
    case 'audio':
    case 'binary':
    case 'document':
    case 'image':
      return undefined;
    default:
      return stringifyForDisplay(value.value);
  }
}
