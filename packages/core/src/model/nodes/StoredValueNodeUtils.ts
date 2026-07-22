import {
  type DataValue,
  type ScalarDataType,
  type ScalarOrArrayDataType,
  getDefaultValue,
  getScalarTypeOf,
  isArrayDataType,
} from '../DataValue.js';
import type { RivetStoredValue } from '../StoredValueStore.js';
import {
  isKnowledgeDocument,
  isKnowledgeEvidence,
  isKnowledgeSourceReference,
} from '../../integrations/KnowledgeStoreValidation.js';

export const portableStoredValueScalarTypes = [
  'any',
  'boolean',
  'string',
  'number',
  'date',
  'time',
  'datetime',
  'object',
  'vector',
  'knowledge-source',
  'knowledge-document',
  'knowledge-evidence',
] satisfies ScalarDataType[];

export function storedValueToDataValue(value: RivetStoredValue, dataType: ScalarOrArrayDataType): DataValue {
  const outputValue = isStoredValueCompatibleWithDataType(value, dataType) ? value : getDefaultValue(dataType);
  return { type: dataType, value: outputValue } as DataValue;
}

export function missingStoredValueDataValue(dataType: ScalarOrArrayDataType): DataValue {
  return { type: dataType, value: getDefaultValue(dataType) } as DataValue;
}

function isStoredValueCompatibleWithDataType(value: RivetStoredValue, dataType: ScalarOrArrayDataType): boolean {
  if (isArrayDataType(dataType)) {
    return (
      Array.isArray(value) &&
      value.every((item) => isStoredValueCompatibleWithScalarType(item, getScalarTypeOf(dataType)))
    );
  }

  return isStoredValueCompatibleWithScalarType(value, dataType);
}

function isStoredValueCompatibleWithScalarType(value: RivetStoredValue, dataType: ScalarDataType): boolean {
  switch (dataType) {
    case 'any':
      return true;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
    case 'date':
    case 'time':
    case 'datetime':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'vector':
      return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
    case 'knowledge-source':
      return isKnowledgeSourceReference(value);
    case 'knowledge-document':
      return isKnowledgeDocument(value);
    case 'knowledge-evidence':
      return isKnowledgeEvidence(value);
    default:
      return false;
  }
}
