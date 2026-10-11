import type { DataValue, ScalarOrArrayDataValue } from './DataValue.js';
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

/**
 * Graph Outputs with the same public ID retain the first non-excluded value.
 * Normal execution, frozen replay, and control-flow exclusion all use this
 * single boundary rule.
 */
export function commitGraphOutputValue(graphOutputs: GraphOutputs, outputId: string, value: DataValue): void {
  if (graphOutputs[outputId] == null || graphOutputs[outputId]?.type === 'control-flow-excluded') {
    graphOutputs[outputId] = value;
  }
}

export type GraphCostBreakdown = { llm: number; classifier: number; other: number };

/** Safe family totals carried across graph and tool boundaries, separate from node diagnostics. */
export function readGraphCostBreakdown(outputs: Outputs): GraphCostBreakdown | undefined {
  const output = outputs['costBreakdown' as PortId];
  if (
    output?.type !== 'object' ||
    output.value == null ||
    typeof output.value !== 'object' ||
    Array.isArray(output.value)
  )
    return undefined;
  // Metadata is data, not executable plugin/authored accessors. Read each own
  // field exactly once and never invoke a getter while accounting a node.
  const fields = ['llm', 'classifier', 'other'].map((key) => Object.getOwnPropertyDescriptor(output.value, key));
  if (
    !fields.every(
      (field) =>
        field &&
        'value' in field &&
        typeof field.value === 'number' &&
        Number.isFinite(field.value) &&
        field.value >= 0,
    )
  )
    return undefined;
  return { llm: fields[0]!.value, classifier: fields[1]!.value, other: fields[2]!.value };
}

export function graphCostBreakdownMatchesCost(breakdown: GraphCostBreakdown, cost: number): boolean {
  const sum = breakdown.llm + breakdown.classifier + breakdown.other;
  return (
    Number.isFinite(cost) &&
    cost >= 0 &&
    Number.isFinite(sum) &&
    Math.abs(sum - cost) <= Number.EPSILON * Math.max(1, Math.abs(cost)) * 8
  );
}

export function addGraphCostBreakdown(
  current: GraphCostBreakdown | undefined,
  addition: GraphCostBreakdown,
): GraphCostBreakdown {
  return {
    llm: (current?.llm ?? 0) + addition.llm,
    classifier: (current?.classifier ?? 0) + addition.classifier,
    other: (current?.other ?? 0) + addition.other,
  };
}

export function ensureGraphCostOutput(
  graphOutputs: GraphOutputs,
  totalCost: number,
  breakdown?: GraphCostBreakdown,
): void {
  const costPort = 'cost' as PortId;

  if (graphOutputs[costPort] == null) {
    graphOutputs[costPort] = {
      type: 'number',
      value: totalCost,
    };
  }
  if (breakdown && graphOutputs['costBreakdown' as PortId] == null) {
    // Snapshot: early outputs must not change when background work settles.
    graphOutputs['costBreakdown' as PortId] = { type: 'object', value: { ...breakdown } };
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
    if (outputId && valueOutput) {
      commitGraphOutputValue(graphOutputs, outputId, valueOutput);
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
