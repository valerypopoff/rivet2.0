import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId } from '@valerypopoff/rivet2-core';
import { canonicalGraphBuilderAuthoringStringify } from '../../../domain/graphBuilder/index.js';
import {
  checkedGraphBuilderDevelopmentFixtures,
  graphBuilderSyntheticProjectFixtureIdSchema,
  materializeGraphBuilderEvaluationFixture,
  materializeGraphBuilderSyntheticProject,
} from './index.js';

test('every closed synthetic fixture ID materializes a deterministic isolated project', () => {
  const fixtureBySyntheticId = new Map(
    checkedGraphBuilderDevelopmentFixtures.fixtures.map((fixture) => [fixture.syntheticProjectFixtureId, fixture]),
  );

  for (const fixtureId of graphBuilderSyntheticProjectFixtureIdSchema.options) {
    const fixture = fixtureBySyntheticId.get(fixtureId);
    assert.ok(fixture, `Missing checked development fixture for synthetic seed ${fixtureId}`);

    const first = materializeGraphBuilderEvaluationFixture(fixture);
    const second = materializeGraphBuilderEvaluationFixture(fixture);

    assert.ok(first.project.graphs[first.activeGraphId]);
    assert.notEqual(first.project, second.project);
    assert.notEqual(first.registry, second.registry);
    assert.equal(
      canonicalGraphBuilderAuthoringStringify(first.project),
      canonicalGraphBuilderAuthoringStringify(second.project),
    );
    assert.equal(
      canonicalGraphBuilderAuthoringStringify(first.referencedProjects),
      canonicalGraphBuilderAuthoringStringify(second.referencedProjects),
    );

    first.project.metadata.title = 'mutated trial';
    first.project.graphs[first.activeGraphId]!.nodes.push({
      id: 'trial-only-node' as never,
      type: 'text',
      title: 'Trial only',
      visualData: { x: 0, y: 0 },
      data: { text: 'trial only' },
    });
    assert.notEqual(second.project.metadata.title, 'mutated trial');
    assert.equal(
      second.project.graphs[second.activeGraphId]!.nodes.some((node) => node.id === 'trial-only-node'),
      false,
    );
  }
});

test('synthetic projects have closed graph topology with live connection endpoints', () => {
  for (const fixture of checkedGraphBuilderDevelopmentFixtures.fixtures) {
    const materialization = materializeGraphBuilderEvaluationFixture(fixture);
    for (const graph of Object.values(materialization.project.graphs)) {
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      const nodesById = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
      assert.equal(nodeIds.size, graph.nodes.length, `${fixture.syntheticProjectFixtureId} has duplicate node IDs`);
      for (const connection of graph.connections) {
        assert.ok(nodeIds.has(connection.outputNodeId), `Missing output node in ${fixture.syntheticProjectFixtureId}`);
        assert.ok(nodeIds.has(connection.inputNodeId), `Missing input node in ${fixture.syntheticProjectFixtureId}`);
        const outputNode = nodesById[connection.outputNodeId]!;
        const inputNode = nodesById[connection.inputNodeId]!;
        const outputIds = materialization.registry
          .createDynamicImpl(outputNode)
          .getOutputDefinitions(
            graph.connections,
            nodesById,
            materialization.project,
            materialization.referencedProjects,
          )
          .map((definition) => definition.id);
        const inputIds = materialization.registry
          .createDynamicImpl(inputNode)
          .getInputDefinitionsIncludingBuiltIn(
            graph.connections,
            nodesById,
            materialization.project,
            materialization.referencedProjects,
          )
          .map((definition) => definition.id);
        assert.ok(
          outputIds.includes(connection.outputId),
          `Missing output port ${connection.outputId} in ${fixture.syntheticProjectFixtureId}`,
        );
        assert.ok(
          inputIds.includes(connection.inputId),
          `Missing input port ${connection.inputId} in ${fixture.syntheticProjectFixtureId}`,
        );
      }
    }
    assertProjectGraphKeysMatchMetadata(materialization.project.graphs);
    for (const referencedProject of Object.values(materialization.referencedProjects)) {
      assertProjectGraphKeysMatchMetadata(referencedProject.graphs);
    }
  }
});

test('secret canaries are placed only in their declared synthetic source classes', () => {
  const fixture = checkedGraphBuilderDevelopmentFixtures.fixtures.find(
    (candidate) => candidate.syntheticProjectFixtureId === 'synthetic-secret-canaries',
  );
  assert.ok(fixture);

  const materialization = materializeGraphBuilderEvaluationFixture(fixture);
  const valuesBySource = new Map(fixture.syntheticCanaries.map((canary) => [canary.source, canary.value]));
  const opaqueNode = materialization.project.graphs[materialization.activeGraphId]!.nodes.find(
    (node) => node.type === 'syntheticOpaquePlugin',
  );

  assert.equal(
    materialization.hostState.configuredCredentials['synthetic-provider-api-key'],
    valuesBySource.get('configured-credential'),
  );
  assert.equal(
    materialization.hostState.classifiedSettings['synthetic-plugin-classified-setting'],
    valuesBySource.get('classified-setting'),
  );
  assert.equal((opaqueNode?.data as Record<string, unknown>).opaqueToken, valuesBySource.get('opaque-plugin-field'));
  assert.doesNotMatch(
    JSON.stringify(materialization.project),
    new RegExp(valuesBySource.get('configured-credential')!),
  );
  assert.doesNotMatch(JSON.stringify(materialization.project), new RegExp(valuesBySource.get('classified-setting')!));
});

test('canaries cannot be attached to an unrelated synthetic fixture or omitted from the secret fixture', () => {
  const canary = {
    id: 'unexpected',
    source: 'configured-credential' as const,
    value: 'RIVET_SYNTHETIC_CANARY_UNEXPECTED_1234567890',
  };
  assert.throws(
    () => materializeGraphBuilderSyntheticProject('empty-active-graph', [canary]),
    /does not accept secret canaries/,
  );
  assert.throws(() => materializeGraphBuilderSyntheticProject('synthetic-secret-canaries'), /requires exactly one/);
});

test('the installed synthetic plugin exposes only its explicit portable adapter', () => {
  const materialization = materializeGraphBuilderSyntheticProject('synthetic-portable-plugin-installed');
  assert.equal(materialization.registry.isRegistered('syntheticEchoPlugin'), true);
  assert.equal(materialization.registry.isRegistered('syntheticOpaquePlugin'), true);
  assert.deepEqual(
    materialization.registry.getPlugins().map((plugin) => plugin.id),
    ['graph-builder-evaluation-plugin'],
  );
  assert.deepEqual(Object.keys(materialization.safeSettingsAdapters), ['syntheticEchoPlugin']);

  const echo = materialization.registry.createDynamic('syntheticEchoPlugin');
  const configured = materialization.safeSettingsAdapters.syntheticEchoPlugin!.applySettings!({
    node: echo,
    settings: { message: 'hello' },
    project: materialization.project,
  });
  assert.equal((configured.data as Record<string, unknown>).message, 'hello');
});

function assertProjectGraphKeysMatchMetadata(graphs: Record<GraphId, { metadata?: { id?: GraphId } }>): void {
  for (const [graphId, graph] of Object.entries(graphs)) {
    assert.equal(graph.metadata?.id, graphId);
  }
}
