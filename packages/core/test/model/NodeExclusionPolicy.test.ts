import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createExcludedNodeOutputs,
  getControlFlowExclusionDecision,
  getMissingRequiredInputExclusion,
} from '../../src/model/NodeExclusionPolicy.js';
import { LOOP_NOT_BROKEN_SENTINEL } from '../../src/model/loopControllerBreak.js';
import {
  IF_PORT,
  type ChartNode,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../../src/model/NodeBase.js';

function makeNode(overrides: Partial<ChartNode> = {}): ChartNode {
  return {
    id: 'node-id',
    type: 'passthrough',
    title: 'Node Title',
    data: {},
    visualData: { x: 0, y: 0, width: 200 },
    ...overrides,
  } as ChartNode;
}

const outputDefinitions: NodeOutputDefinition[] = [
  {
    id: 'output' as PortId,
    title: 'Output',
    dataType: 'string',
  },
];

describe('NodeExclusionPolicy', () => {
  it('excludes disabled nodes before checking their inputs', () => {
    const decision = getControlFlowExclusionDecision({
      node: makeNode({ disabled: true }),
      inputValues: {},
    });

    assert.deepEqual(decision, {
      action: 'exclude',
      reason: 'disabled',
      traceMessage: "Excluding node Node Title because it's disabled",
    });
  });

  it('excludes conditional nodes only when the if input resolves to false in the normal pass', () => {
    const inputValues = {
      [IF_PORT.id]: { type: 'boolean', value: false },
    };

    assert.deepEqual(
      getControlFlowExclusionDecision({
        node: makeNode({ isConditional: true }),
        inputValues,
      }),
      {
        action: 'exclude',
        reason: 'if port is false',
        traceMessage: 'Excluding node Node Title because if port is false',
      },
    );
    assert.deepEqual(
      getControlFlowExclusionDecision({
        node: makeNode({ isConditional: true }),
        inputValues,
        typeOfExclusion: LOOP_NOT_BROKEN_SENTINEL,
      }),
      { action: 'continue' },
    );
  });

  it('excludes ordinary nodes with control-flow-excluded inputs', () => {
    assert.deepEqual(
      getControlFlowExclusionDecision({
        node: makeNode(),
        inputValues: {
          input: { type: 'control-flow-excluded', value: undefined },
        },
      }),
      {
        action: 'exclude',
        reason: 'input is excluded value',
        traceMessage: 'Excluding node Node Title because of control flow. Input is has excluded value: input',
      },
    );
  });

  it('uses scalar control-flow type matching for excluded input values', () => {
    for (const input of [
      { type: 'control-flow-excluded[]', value: [] },
      { type: 'fn<control-flow-excluded>', value: () => undefined },
    ] as const) {
      assert.deepEqual(
        getControlFlowExclusionDecision({
          node: makeNode(),
          inputValues: {
            input,
          },
        }),
        {
          action: 'exclude',
          reason: 'input is excluded value',
          traceMessage: 'Excluding node Node Title because of control flow. Input is has excluded value: input',
        },
      );
    }
  });

  it('lets both Coalesce types consume normal excluded values but defers loop-wait sentinels', () => {
    for (const type of ['coalesce', 'coalesceNew'] as const) {
      assert.deepEqual(
        getControlFlowExclusionDecision({
          node: makeNode({ type }),
          inputValues: {
            input1: { type: 'control-flow-excluded', value: undefined },
          },
        }),
        { action: 'continue' },
      );
      assert.deepEqual(
        getControlFlowExclusionDecision({
          node: makeNode({ type }),
          inputValues: {
            input1: { type: 'control-flow-excluded', value: LOOP_NOT_BROKEN_SENTINEL },
          },
        }),
        { action: 'defer' },
      );
    }
  });

  it('formats missing required input exclusions without owning processor state changes', () => {
    const missingInputs: NodeInputDefinition[] = [
      {
        id: 'object' as PortId,
        title: 'Object',
        dataType: 'object',
        required: true,
      },
    ];

    assert.deepEqual(getMissingRequiredInputExclusion(makeNode(), missingInputs), {
      action: 'exclude',
      reason: 'missing required input',
      traceMessage: 'Excluding node Node Title because required inputs are not connected: Object',
    });
  });

  it('builds excluded outputs and preserves the loop-controller break sentinel', () => {
    assert.deepEqual(createExcludedNodeOutputs(makeNode(), outputDefinitions), {
      output: { type: 'control-flow-excluded', value: undefined },
    });
    assert.deepEqual(createExcludedNodeOutputs(makeNode({ type: 'loopController' }), outputDefinitions), {
      output: { type: 'control-flow-excluded', value: undefined },
      break: { type: 'control-flow-excluded', value: LOOP_NOT_BROKEN_SENTINEL },
    });
  });
});
