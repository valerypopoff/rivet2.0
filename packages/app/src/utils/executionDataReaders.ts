import {
  type DataType,
  type DataValue,
  type Outputs,
  type PortId,
  WarningsPort,
  coerceTypeOptional,
  getWarnings,
} from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import type { DataValueWithRefs, InputsOrOutputsWithRefs, NodeRunDataWithRefs } from '../state/dataFlow.js';
import { restoreStoredInputsOrOutputs, tryRestoreStoredDataValue } from './executionDataStorage.js';
import { hasVisibleStoredSplitOutputValues } from './outputPortVisibility.js';

type RestoredSplitOutputs = {
  [index: number]: Outputs;
};

export type RestoredNodeOutputs = Outputs | RestoredSplitOutputs;

export function hasStoredPortMapValues(data: InputsOrOutputsWithRefs | undefined): boolean {
  return data != null && Object.values(data).some((value) => value != null);
}

export function hasStoredSplitOutputValues(
  splitOutputData: NodeRunDataWithRefs['splitOutputData'],
): splitOutputData is NonNullable<NodeRunDataWithRefs['splitOutputData']> {
  return splitOutputData != null && Object.values(splitOutputData).some(hasStoredPortMapValues);
}

export function restoreStoredPortMap(
  data: InputsOrOutputsWithRefs | undefined,
  dataRefs: DataRefReader,
): Outputs | undefined {
  return restoreStoredInputsOrOutputs(data, dataRefs) as Outputs | undefined;
}

export function tryRestoreStoredPortMap(
  data: InputsOrOutputsWithRefs | undefined,
  dataRefs: DataRefReader,
): Outputs | undefined {
  if (!data) {
    return undefined;
  }

  const restoredEntries: Array<[PortId, DataValue]> = [];

  for (const [portId, storedValue] of Object.entries(data) as Array<[PortId, DataValueWithRefs | undefined]>) {
    if (storedValue == null) {
      continue;
    }

    const restoredValue = tryRestoreStoredDataValue(storedValue, dataRefs);
    if (restoredValue) {
      restoredEntries.push([portId, restoredValue]);
    }
  }

  return restoredEntries.length > 0 ? (Object.fromEntries(restoredEntries) as Outputs) : undefined;
}

export function restoreStoredPortValue(
  outputs: InputsOrOutputsWithRefs | undefined,
  portId: PortId,
  dataRefs: DataRefReader,
): DataValue | undefined {
  return tryRestoreStoredDataValue(outputs?.[portId], dataRefs);
}

export function coerceStoredPortValue<T extends DataType>(
  outputs: InputsOrOutputsWithRefs | undefined,
  portId: PortId,
  dataType: T,
  dataRefs: DataRefReader,
): Extract<DataValue, { type: T }> | undefined {
  const restoredValue = restoreStoredPortValue(outputs, portId, dataRefs);
  const coercedValue = coerceTypeOptional(restoredValue, dataType);

  if (coercedValue === undefined) {
    return undefined;
  }

  return {
    type: dataType,
    value: coercedValue,
  } as Extract<DataValue, { type: T }>;
}

export function restoreDisplayedNodeOutputs(
  data: Pick<NodeRunDataWithRefs, 'outputData' | 'splitOutputData'>,
  dataRefs: DataRefReader,
): RestoredNodeOutputs | undefined {
  if (hasVisibleStoredSplitOutputValues(data.splitOutputData)) {
    return restoreSplitOutputs(data.splitOutputData, dataRefs);
  }

  const restoredOutputData = restoreStoredPortMap(data.outputData, dataRefs);
  if (restoredOutputData && Object.keys(restoredOutputData).length > 0) {
    return restoredOutputData;
  }

  if (hasStoredSplitOutputValues(data.splitOutputData)) {
    return restoreSplitOutputs(data.splitOutputData, dataRefs);
  }

  return undefined;
}

export function getStoredOutputWarnings(
  data: Pick<NodeRunDataWithRefs, 'outputData' | 'splitOutputData'>,
  dataRefs: DataRefReader,
): string[] | undefined {
  const warnings = new Set<string>();

  collectWarningsFromOutputs(data.outputData, dataRefs, warnings);

  if (data.splitOutputData) {
    for (const outputs of Object.values(data.splitOutputData)) {
      collectWarningsFromOutputs(outputs, dataRefs, warnings);
    }
  }

  return warnings.size > 0 ? [...warnings] : undefined;
}

function collectWarningsFromOutputs(
  outputData: NodeRunDataWithRefs['outputData'],
  dataRefs: DataRefReader,
  warnings: Set<string>,
): void {
  const warningsValue = restoreStoredPortValue(outputData, WarningsPort as PortId, dataRefs);
  if (!warningsValue) {
    return;
  }

  const nextWarnings = coerceTypeOptional(warningsValue, 'string[]') ?? getWarnings({ [WarningsPort]: warningsValue });

  for (const warning of nextWarnings ?? []) {
    warnings.add(warning);
  }
}

function restoreSplitOutputs(
  splitOutputData: NonNullable<NodeRunDataWithRefs['splitOutputData']>,
  dataRefs: DataRefReader,
): RestoredSplitOutputs | undefined {
  const restoredSplitOutputs: RestoredSplitOutputs = {};

  for (const [index, outputs] of Object.entries(splitOutputData).sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    const restoredOutputs = restoreStoredPortMap(outputs, dataRefs);
    if (!restoredOutputs || Object.keys(restoredOutputs).length === 0) {
      continue;
    }

    restoredSplitOutputs[Number(index)] = restoredOutputs;
  }

  return Object.keys(restoredSplitOutputs).length > 0 ? restoredSplitOutputs : undefined;
}
