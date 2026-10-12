import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFrozenGraphBoundaryEffects,
  ensureGraphCostOutput,
  readGraphCostBreakdown,
  graphCostBreakdownMatchesCost,
} from '../../src/model/GraphBoundaryEffects.js';
import {
  GraphProcessor,
  createBuiltInRegistry,
  LLMChatV2NodeImpl,
  ClassifierEvaluateNodeImpl,
  SubGraphNodeImpl,
  CallGraphNodeImpl,
  GraphReferenceNodeImpl,
  GraphOutputNodeImpl,
  ReferencedGraphAliasNodeImpl,
  type ChartNode,
  type GraphOutputs,
  type Outputs,
  type GraphId,
  type ProjectId,
  type Project,
  type NodeGraph,
  type NodeConnection,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

void describe('GraphBoundaryEffects', () => {
  void it('snapshots cost families and preserves authored metric outputs', () => {
    const breakdown = { llm: 2, classifier: 3, other: 1 };
    const outputs: GraphOutputs = {};
    ensureGraphCostOutput(outputs, 6, breakdown);
    breakdown.classifier = 99;
    assert.deepEqual(outputs.costBreakdown, { type: 'object', value: { llm: 2, classifier: 3, other: 1 } });
    ensureGraphCostOutput(outputs, 100, breakdown);
    assert.equal(outputs.cost?.value, 6);
    assert.equal((outputs.costBreakdown?.value as { classifier: number }).classifier, 3);
    for (const value of [
      null,
      [],
      'bad',
      { llm: -1, classifier: 0, other: 0 },
      { llm: 0, classifier: NaN, other: 0 },
      { llm: 1 },
    ]) {
      assert.equal(readGraphCostBreakdown({ costBreakdown: { type: 'object', value } } as Outputs), undefined);
    }
    assert.deepEqual(
      readGraphCostBreakdown({
        costBreakdown: { type: 'object', value: { llm: 2, classifier: 3, other: 1, extra: 'ignored' } },
      }),
      { llm: 2, classifier: 3, other: 1 },
    );
  });

  void it('rejects inherited/accessor breakdown fields without executing authored code', () => {
    let reads = 0;
    const value = { llm: 0.2, classifier: 0.03, other: 0 };
    Object.defineProperty(value, 'classifier', {
      get() {
        reads++;
        throw new Error('must not run');
      },
    });
    assert.equal(readGraphCostBreakdown({ costBreakdown: { type: 'object', value } }), undefined);
    assert.equal(reads, 0);
    assert.equal(
      readGraphCostBreakdown({
        costBreakdown: { type: 'object', value: Object.create({ llm: 1, classifier: 0, other: 0 }) },
      }),
      undefined,
    );
    assert.equal(graphCostBreakdownMatchesCost({ llm: 0.2, classifier: 0.03, other: 0 }, 0.23), true);
    assert.equal(graphCostBreakdownMatchesCost({ llm: 0.2, classifier: 0.03, other: 0 }, 2), false);
    assert.equal(
      graphCostBreakdownMatchesCost({ llm: Number.MAX_VALUE, classifier: Number.MAX_VALUE, other: 0 }, Infinity),
      false,
    );
  });

  void it('ignores invalid node costs before they can poison the combined total', async () => {
    const llm = LLMChatV2NodeImpl.create();
    const classifier = ClassifierEvaluateNodeImpl.create();
    const id = 'invalid-costs' as GraphId;
    const project: Project = {
      metadata: { id: 'project' as ProjectId, title: 'Costs', description: '', mainGraphId: id },
      graphs: {
        [id]: { metadata: { id, name: 'Costs', description: '' }, nodes: [llm, classifier], connections: [] },
      },
    };
    const processor = new GraphProcessor(project, id, createBuiltInRegistry());
    for (const cost of [-1, NaN, Infinity]) {
      processor.setFrozenNodeOutputResolver(({ node }) => ({
        cost: { type: 'number', value: node.id === llm.id ? cost : 0.03 },
      }));
      const outputs = await processor.processGraph(testProcessContext());
      assert.equal(outputs.cost?.value, 0.03);
      assert.deepEqual(outputs.costBreakdown?.value, { llm: 0, classifier: 0.03, other: 0 });
    }
  });

  for (const mode of ['direct', 'subgraph', 'optimized-subgraph', 'callGraph', 'alias']) {
    void it(`accounts mixed LLM/classifier costs exactly once through ${mode} and resets repeated runs`, async () => {
      const llm = LLMChatV2NodeImpl.create();
      const classifier = ClassifierEvaluateNodeImpl.create();
      const result = GraphOutputNodeImpl.create();
      result.data.id = 'result';
      result.data.dataType = 'string';
      const child: NodeGraph = {
        metadata: { id: 'child' as GraphId, name: 'Child', description: '' },
        nodes: [llm, classifier, result],
        connections: [
          { outputNodeId: llm.id, outputId: 'response', inputNodeId: result.id, inputId: 'value' } as NodeConnection,
        ],
      };
      const subgraph = SubGraphNodeImpl.create();
      subgraph.data.graphId = 'child' as GraphId;
      subgraph.data.skipUnusedOutputs = mode === 'optimized-subgraph';
      const reference = GraphReferenceNodeImpl.create();
      reference.data.graphId = 'child' as GraphId;
      const call = CallGraphNodeImpl.create();
      const alias = ReferencedGraphAliasNodeImpl.create();
      alias.data.projectId = 'referenced' as ProjectId;
      alias.data.graphId = 'child' as GraphId;
      alias.data.outputCostDuration = false;
      const parentResult = GraphOutputNodeImpl.create();
      parentResult.data.id = 'result';
      const dynamic = mode === 'callGraph';
      const parent: NodeGraph = {
        metadata: { id: 'parent' as GraphId, name: 'Parent', description: '' },
        nodes: mode === 'alias' ? [alias] : dynamic ? [reference, call] : [subgraph, parentResult],
        connections:
          mode === 'alias'
            ? []
            : dynamic
              ? [
                  {
                    outputNodeId: reference.id,
                    outputId: 'graph',
                    inputNodeId: call.id,
                    inputId: 'graph',
                  } as NodeConnection,
                ]
              : [
                  {
                    outputNodeId: subgraph.id,
                    outputId: 'result',
                    inputNodeId: parentResult.id,
                    inputId: 'value',
                  } as NodeConnection,
                ],
      };
      const id = (mode === 'direct' ? 'child' : 'parent') as GraphId;
      const project: Project = {
        metadata: { id: 'cost-project' as ProjectId, title: 'Cost', description: '', mainGraphId: id },
        plugins: [],
        graphs: { child, parent },
      };
      if (mode === 'alias') project.references = [{ id: alias.data.projectId }];
      const referenced: Project = {
        ...project,
        metadata: { ...project.metadata, id: alias.data.projectId },
        references: [],
        graphs: { child },
      };
      const processor = new GraphProcessor(project, id, createBuiltInRegistry());
      processor.setFrozenNodeOutputResolver(({ node }) =>
        node.id === llm.id
          ? { cost: { type: 'number', value: 0.2 }, response: { type: 'string', value: 'done' } }
          : node.id === classifier.id
            ? { cost: { type: 'number', value: 0.03 } }
            : undefined,
      );
      for (let run = 0; run < 2; run++) {
        const outputs = await processor.processGraph({
          ...testProcessContext(),
          projectReferenceLoader: { loadProject: async () => referenced },
        });
        // Optimized subgraphs intentionally do not execute disconnected nodes.
        const classifierCost = mode === 'optimized-subgraph' ? 0 : 0.03;
        assert.equal(outputs.cost?.value, 0.2 + classifierCost);
        assert.deepEqual(outputs.costBreakdown, {
          type: 'object',
          value: { llm: 0.2, classifier: classifierCost, other: 0 },
        });
      }
    });
  }

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
