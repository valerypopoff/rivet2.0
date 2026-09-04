import { getScalarTypeOf, type ControlFlowExcludedDataValue, type DataValue } from './DataValue.js';
import {
  IF_PORT,
  type ChartNode,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from './NodeBase.js';
import type { BuiltInNodeType } from './Nodes.js';
import { coerceTypeOptional } from '../utils/coerceType.js';
import { entries } from '../utils/typeSafety.js';
import { LOOP_NOT_BROKEN_SENTINEL } from './loopControllerBreak.js';

type NodePortValues = Record<PortId, DataValue | undefined>;

export type NodeExclusionReason = 'disabled' | 'if port is false' | 'input is excluded value' | 'missing required input';

export type NodeExclusionDecision =
  | {
      action: 'continue' | 'defer';
    }
  | {
      action: 'exclude';
      reason: NodeExclusionReason;
      traceMessage: string;
    };

const nodesAllowedToConsumeExcludedValue = new Set<BuiltInNodeType>([
  'if',
  'ifElse',
  'coalesce',
  'graphOutput',
  'raceInputs',
  'loopController',
]);

/**
 * Whether a node intentionally handles an input that was excluded by control
 * flow. Most nodes are excluded themselves in that situation; these nodes
 * implement their own fallback, branching, or aggregation behavior instead.
 */
export function canConsumeControlFlowExcludedInput(node: ChartNode): boolean {
  return nodesAllowedToConsumeExcludedValue.has(node.type as BuiltInNodeType);
}

function isControlFlowExcluded(value: DataValue | undefined): value is DataValue {
  return value != null && getScalarTypeOf(value.type) === 'control-flow-excluded';
}

export function getControlFlowExclusionDecision({
  inputValues,
  node,
  typeOfExclusion,
}: {
  inputValues: NodePortValues;
  node: ChartNode;
  typeOfExclusion?: ControlFlowExcludedDataValue['value'];
}): NodeExclusionDecision {
  if (node.disabled) {
    return {
      action: 'exclude',
      reason: 'disabled',
      traceMessage: `Excluding node ${node.title} because it's disabled`,
    };
  }

  if (node.isConditional && typeOfExclusion === undefined) {
    const ifValue = coerceTypeOptional(inputValues[IF_PORT.id], 'boolean');
    if (ifValue === false) {
      return {
        action: 'exclude',
        reason: 'if port is false',
        traceMessage: `Excluding node ${node.title} because if port is false`,
      };
    }
  }

  const controlFlowExcludedValues = entries(inputValues).filter(
    ([, value]) =>
      isControlFlowExcluded(value) && (typeOfExclusion === undefined || value.value === typeOfExclusion),
  );
  const isWaitingForLoop = controlFlowExcludedValues.some(([, value]) => value?.value === LOOP_NOT_BROKEN_SENTINEL);
  const allowedToConsumeExcludedValue = canConsumeControlFlowExcludedInput(node) && !isWaitingForLoop;

  if (controlFlowExcludedValues.length === 0 || allowedToConsumeExcludedValue) {
    return { action: 'continue' };
  }

  if (isWaitingForLoop) {
    return { action: 'defer' };
  }

  return {
    action: 'exclude',
    reason: 'input is excluded value',
    traceMessage: `Excluding node ${node.title} because of control flow. Input is has excluded value: ${controlFlowExcludedValues[0]?.[0]}`,
  };
}

export function getMissingRequiredInputExclusion(
  node: ChartNode,
  missingRequiredInputs: NodeInputDefinition[],
): Extract<NodeExclusionDecision, { action: 'exclude' }> {
  const missingInputNames = missingRequiredInputs.map((input) => input.title || input.id).join(', ');

  return {
    action: 'exclude',
    reason: 'missing required input',
    traceMessage: `Excluding node ${node.title} because required inputs are not connected: ${missingInputNames}`,
  };
}

export function createExcludedNodeOutputs(node: ChartNode, outputDefinitions: NodeOutputDefinition[]): NodePortValues {
  const outputs: NodePortValues = {};

  for (const output of outputDefinitions) {
    outputs[output.id] = { type: 'control-flow-excluded', value: undefined };
  }

  if (node.type === 'loopController') {
    outputs['break' as PortId] = { type: 'control-flow-excluded', value: LOOP_NOT_BROKEN_SENTINEL };
  }

  return outputs;
}
