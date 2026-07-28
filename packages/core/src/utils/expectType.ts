import {
  type DataType,
  type DataValue,
  type FunctionDataType,
  type GetDataValue,
  functionTypeToReturnType,
  getScalarTypeOf,
  isArrayDataType,
  isArrayDataValue,
  isFunctionDataType,
  isScalarDataValue,
  unwrapDataValue,
} from '../model/DataValue.js';

function getDeferredValue(value: DataValue, type: FunctionDataType): (() => unknown) | undefined {
  const targetReturnType = functionTypeToReturnType(type);

  if (isFunctionDataType(value.type)) {
    const sourceReturnType = functionTypeToReturnType(value.type);
    return targetReturnType === 'any' || sourceReturnType === 'any' || sourceReturnType === targetReturnType
      ? (value.value as () => unknown)
      : undefined;
  }

  if (value.type === 'any' && typeof value.value === 'function') {
    return value.value as () => unknown;
  }

  if (targetReturnType === 'any' || value.type === 'any' || value.type === targetReturnType) {
    return () => value.value;
  }

  return undefined;
}

export function expectType<T extends DataType>(value: DataValue | undefined, type: T): GetDataValue<T>['value'] {
  if (isArrayDataType(type) && isArrayDataValue(value) && getScalarTypeOf(type) === getScalarTypeOf(value.type)) {
    return value.value as unknown as GetDataValue<T>['value'];
  }

  // Allow a string to be expected for a string[], just return an array of one element
  if (isArrayDataType(type) && isScalarDataValue(value) && getScalarTypeOf(type) === value.type) {
    return [value.value] as GetDataValue<T>['value'];
  }

  if (value?.type === type) {
    return value.value as GetDataValue<T>['value'];
  }

  if (value && isFunctionDataType(type)) {
    const deferredValue = getDeferredValue(value, type);
    if (deferredValue) {
      return deferredValue as GetDataValue<T>['value'];
    }
  }

  if (type === 'any' || type === 'any[]' || value?.type === 'any' || value?.type === 'any[]') {
    return value?.value as GetDataValue<T>['value'];
  }

  throw new Error(`Expected value of type ${type} but got ${value?.type}`);
}

export function expectTypeOptional<T extends DataType>(
  value: DataValue | undefined,
  type: T,
): GetDataValue<T>['value'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isArrayDataType(type) && isArrayDataValue(value) && getScalarTypeOf(type) === getScalarTypeOf(value.type)) {
    // @ts-expect-error Generic T is not narrowed to its array subtype within this runtime-guarded branch.
    return value.value as unknown as GetDataValue<T>['value'];
  }

  // Allow a string to be expected for a string[], just return an array of one element
  if (isArrayDataType(type) && isScalarDataValue(value) && getScalarTypeOf(type) === value.type) {
    return [value.value] as GetDataValue<T>['value'] | undefined;
  }

  if (value.type === type) {
    // @ts-expect-error Generic T is not narrowed by comparing a DataValue's discriminant to T.
    return value.value as GetDataValue<T>['value'];
  }

  if (isFunctionDataType(type)) {
    const deferredValue = getDeferredValue(value, type);
    if (deferredValue) {
      // @ts-expect-error Generic T is not narrowed to its function subtype within this runtime-guarded branch.
      return deferredValue as GetDataValue<T>['value'];
    }
  }

  // We allow a fn<string> to be expected for a string, so unwrap it on demand
  if (isFunctionDataType(value.type) && value.type === `fn<${type}>`) {
    value = unwrapDataValue(value);
  }

  if (value.type !== type) {
    throw new Error(`Expected value of type ${type} but got ${value?.type}`);
  }
  return value.value as GetDataValue<T>['value'] | undefined;
}
