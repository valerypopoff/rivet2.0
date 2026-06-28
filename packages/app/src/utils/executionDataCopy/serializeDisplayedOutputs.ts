import { type DataValue, type NodeOutputDefinition, type PortId } from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../../providers/ProvidersContext.js';
import type { DataValueWithRefs, InputsOrOutputsWithRefs, NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { isStoredRefDataValue, tryRestoreStoredDataValue } from '../executionDataStorage.js';
import { hasVisibleStoredPortMapValues, isVisibleOutputPort } from '../outputPortVisibility.js';
import { displayCopySections, isDisplayCopySections } from './displayCopySections.js';
import { projectDataValue } from './projectDataValue.js';

export type NodeOutputCopyValueProjectorArgs = {
  outputs: InputsOrOutputsWithRefs;
  dataRefs: DataRefReader;
};

export type NodeOutputCopyValueProjector = (args: NodeOutputCopyValueProjectorArgs) => unknown | undefined;

const MISSING_STORED_VALUE_TEXT = 'Value no longer available in memory.';

export function serializeDisplayedOutputs(
  data: Pick<NodeRunDataWithRefs, 'outputData' | 'splitOutputData'>,
  dataRefs: DataRefReader,
  options?: {
    getCopyValueData?: NodeOutputCopyValueProjector;
    outputDefinitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[];
  },
): string | undefined {
  const { getCopyValueData, outputDefinitions } = options ?? {};

  if (!getCopyValueData) {
    return serializeGenericDisplayedOutputs(data, dataRefs, outputDefinitions);
  }

  const visibleSplitOutputs = getSortedVisibleSplitOutputs(data.splitOutputData);

  if (visibleSplitOutputs.length > 0) {
    const serializedSplits = visibleSplitOutputs.flatMap(([, outputs]) => {
      const projectedValue = getCopyValueData({ outputs, dataRefs });
      return projectedValue === undefined ? [] : [serializeProjectedCopyValue(projectedValue)];
    });

    return serializedSplits.length > 0 ? serializedSplits.join('\n\n') : undefined;
  }

  const projectedOutputs = hasVisibleStoredPortMapValues(data.outputData)
    ? getCopyValueData({ outputs: data.outputData, dataRefs })
    : undefined;
  if (projectedOutputs === undefined) {
    return undefined;
  }

  return serializeProjectedCopyValue(projectedOutputs);
}

export function isVisiblePort(portId: PortId | string): boolean {
  return isVisibleOutputPort(portId);
}

export function projectStoredPortValueForCopy(
  outputs: InputsOrOutputsWithRefs,
  portId: PortId,
  dataRefs: DataRefReader,
): unknown | undefined {
  return projectDataValueForCopy(outputs[portId], dataRefs);
}

export function projectDataValueForCopy(
  value: DataValueWithRefs | DataValue | undefined,
  dataRefs: DataRefReader,
): unknown | undefined {
  if (value == null) {
    return undefined;
  }

  const restoredValue = tryRestoreStoredDataValue(value as DataValueWithRefs, dataRefs);
  if (restoredValue) {
    return projectDataValue(restoredValue);
  }

  return isStoredRefDataValue(value) ? MISSING_STORED_VALUE_TEXT : 'undefined';
}

export function serializeDisplayedDataValue(
  value: DataValueWithRefs | DataValue | undefined,
  dataRefs: DataRefReader,
): string | undefined {
  const projectedValue = projectDataValueForCopy(value, dataRefs);
  return projectedValue === undefined ? undefined : serializeProjectedCopyValue(projectedValue);
}

export function serializeDisplayedPortValue(
  outputs: InputsOrOutputsWithRefs,
  portId: PortId | string,
  dataRefs: DataRefReader,
): string | undefined {
  const value = outputs[portId as PortId];
  if (value == null) {
    return undefined;
  }

  return serializeDisplayedDataValue(value, dataRefs);
}

function serializeGenericDisplayedOutputs(
  data: Pick<NodeRunDataWithRefs, 'outputData' | 'splitOutputData'>,
  dataRefs: DataRefReader,
  outputDefinitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[],
): string | undefined {
  const visibleSplitOutputs = getSortedVisibleSplitOutputs(data.splitOutputData);

  if (visibleSplitOutputs.length > 0) {
    const serializedSplits = visibleSplitOutputs.flatMap(([, outputs]) => {
      const serialized = serializeStoredOutputPortMap(outputs, dataRefs, outputDefinitions);
      return serialized === undefined ? [] : [serialized];
    });

    return serializedSplits.length > 0 ? serializedSplits.join('\n\n') : undefined;
  }

  return serializeStoredOutputPortMap(data.outputData, dataRefs, outputDefinitions);
}

function getSortedVisibleSplitOutputs(
  splitOutputData: NodeRunDataWithRefs['splitOutputData'],
): Array<[string, InputsOrOutputsWithRefs]> {
  return Object.entries(splitOutputData ?? {})
    .filter((entry): entry is [string, InputsOrOutputsWithRefs] => hasVisibleStoredPortMapValues(entry[1]))
    .sort(([left], [right]) => Number(left) - Number(right));
}

function serializeStoredOutputPortMap(
  outputs: InputsOrOutputsWithRefs | undefined,
  dataRefs: DataRefReader,
  outputDefinitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[],
): string | undefined {
  if (!outputs) {
    return undefined;
  }

  const visibleEntries = Object.keys(outputs)
    .filter((portId) => isVisiblePort(portId) && outputs[portId as PortId] != null)
    .map((portId) => ({
      label: outputDefinitions?.find((definition) => definition.id === portId)?.title ?? portId,
      value: projectStoredPortValueForCopy(outputs, portId as PortId, dataRefs),
    }));

  if (visibleEntries.length === 0) {
    return undefined;
  }

  if (visibleEntries.length === 1) {
    return serializeProjectedCopyValue(visibleEntries[0]!.value);
  }

  return serializeProjectedCopyValue(displayCopySections(visibleEntries));
}

function serializeProjectedCopyValue(value: unknown): string {
  if (isDisplayCopySections(value)) {
    return value.sections
      .map(({ label, value: sectionValue }) => `${label}\n${serializeProjectedCopyValue(sectionValue)}`)
      .join('\n\n');
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}
