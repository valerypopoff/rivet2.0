import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyFrozenGraphBoundaryEffects, ensureGraphCostOutput } from '../../src/model/GraphBoundaryEffects.js';
import type { ChartNode, GraphOutputs, Outputs } from '../../src/index.js';

void describe('GraphBoundaryEffects', () => {
  void it('adds the total cost output without replacing an explicit cost', () => {
    const graphOutputs: GraphOutputs = {};

    ensureGraphCostOutput(graphOutputs, 12);
    assert.deepEqual(graphOutputs.cost, { type: 'number', value: 12 });

    graphOutputs.cost = { type: 'number', value: 3 };
    ensureGraphCostOutput(graphOutputs, 99);
    assert.deepEqual(graphOutputs.cost, { type: 'number', value: 3 });
  });

  void it('applies frozen graph output values to graph outputs', () => {
    const graphOutputs: GraphOutputs = {};
    const node = {
      type: 'graphOutput',
      data: { id: 'result' },
    } as ChartNode;
    const outputValues: Outputs = {
      valueOutput: { type: 'string', value: 'done' },
    };

    const effect = applyFrozenGraphBoundaryEffects(graphOutputs, node, outputValues);

    assert.equal(effect, undefined);
    assert.deepEqual(graphOutputs.result, { type: 'string', value: 'done' });
  });

  void it('returns frozen set-global effects without mutating graph outputs', () => {
    const graphOutputs: GraphOutputs = {};
    const node = {
      type: 'setGlobal',
    } as ChartNode;
    const outputValues: Outputs = {
      'saved-value': { type: 'string', value: 'stored' },
      variable_id_out: { type: 'string', value: 'global-name' },
    };

    const effect = applyFrozenGraphBoundaryEffects(graphOutputs, node, outputValues);

    assert.deepEqual(effect, {
      type: 'setGlobal',
      variableId: 'global-name',
      value: { type: 'string', value: 'stored' },
    });
    assert.deepEqual(graphOutputs, {});
  });

  void it('returns frozen Set Stored Value cache effects', () => {
    const effect = applyFrozenGraphBoundaryEffects(
      {},
      { type: 'setStoredValue' } as ChartNode,
      {
        'saved-value': { type: 'object', value: { summary: 'frozen' } },
        key: { type: 'string', value: 'analysis' },
      } as Outputs,
    );

    assert.deepEqual(effect, {
      type: 'setStoredValue',
      key: 'analysis',
      value: { summary: 'frozen' },
    });
  });

  void it('ignores set-global frozen outputs without a usable variable id', () => {
    const effect = applyFrozenGraphBoundaryEffects(
      {},
      { type: 'setGlobal' } as ChartNode,
      {
        'saved-value': { type: 'string', value: 'stored' },
        variable_id_out: { type: 'number', value: 1 },
      } as Outputs,
    );

    assert.equal(effect, undefined);
  });
});
