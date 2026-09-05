import type { ScalarOrArrayDataValue } from './DataValue.js';
import type { GraphOutputs, Outputs } from './GraphProcessor.js';
import type { ChartNode, PortId } from './NodeBase.js';
import type { RivetStoredValue } from './StoredValueStore.js';

export type FrozenSetGlobalEffect = {
  type: 'setGlobal';
  variableId: string;
  value: ScalarOrArrayDataValue;
};

export type FrozenSetStoredValueEffect = {
  type: 'setStoredValue';
  key: string;
  value: RivetStoredValue;
};

export type FrozenGraphBoundaryEffect = FrozenSetGlobalEffect | FrozenSetStoredValueEffect;

export function ensureGraphCostOutput(graphOutputs: GraphOutputs, totalCost: number): void {
  const costPort = 'cost' as PortId;

  if (graphOutputs[costPort] == null) {
    graphOutputs[costPort] = {
      type: 'number',
      value: totalCost,
    };
  }
}

export function applyFrozenGraphBoundaryEffects(
  graphOutputs: GraphOutputs,
  node: ChartNode,
  outputValues: Outputs,
): FrozenGraphBoundaryEffect | undefined {
  if (node.type === 'graphOutput') {
    const outputId = (node.data as { id?: string } | undefined)?.id;
    const valueOutput = outputValues['valueOutput' as PortId];

    // Duplicate Graph Outputs share the ordinary first-non-excluded winner,
    // whether a producer is computed or replayed from frozen outputs.
    if (
      outputId &&
      valueOutput &&
      (graphOutputs[outputId] == null || graphOutputs[outputId]?.type === 'control-flow-excluded')
    ) {
      graphOutputs[outputId] = valueOutput;
    }

    return undefined;
  }

  if (node.type === 'setStoredValue') {
    const savedValue = outputValues['saved-value' as PortId];
    const key = outputValues['key' as PortId];
    const keyValue = key?.type === 'string' ? key.value : undefined;

    if (!keyValue || !savedValue) return undefined;
    return {
      type: 'setStoredValue',
      key: keyValue,
      value: savedValue.value as RivetStoredValue,
    };
  }

  if (node.type !== 'setGlobal') {
    return undefined;
  }

  const savedValue = outputValues['saved-value' as PortId];
  const variableId = outputValues['variable_id_out' as PortId];
  const variableIdValue = variableId?.type === 'string' ? variableId.value : undefined;

  if (!variableIdValue || !savedValue) {
    return undefined;
  }

  return {
    type: 'setGlobal',
    variableId: variableIdValue,
    value: savedValue as ScalarOrArrayDataValue,
  };
}
