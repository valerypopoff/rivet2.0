import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChartNode, GraphId, NodeGraph, NodePrefabId, PluginLoadSpec, Project } from '@valerypopoff/rivet2-core';
import {
  deriveProjectPluginSpecsFromGraphs,
  getMissingAppPluginSpecs,
  getPluginSpecDetails,
  getPluginSpecLabel,
  pluginSpecMatchesSearch,
  type PluginUsageRegistry,
  type PluginUsageState,
} from './pluginUsage.js';

const pluginSpec: PluginLoadSpec = {
  type: 'package',
  id: '@example/rivet-plugin@latest',
  package: '@example/rivet-plugin',
  tag: 'latest',
};

const builtInPluginSpec: PluginLoadSpec = {
  type: 'built-in',
  id: 'openai',
  name: 'OpenAI',
};

function makeProject(
  graphs: NodeGraph[],
  plugins: PluginLoadSpec[] = [],
  nodePrefabs: Project['nodePrefabs'] = undefined,
): Pick<Project, 'graphs' | 'nodePrefabs' | 'plugins'> {
  return {
    graphs: Object.fromEntries(graphs.map((graph) => [graph.metadata!.id!, graph])),
    nodePrefabs,
    plugins,
  };
}

function makeGraph(id: string, nodes: ChartNode[]): NodeGraph {
  return {
    metadata: {
      id: id as GraphId,
      name: id,
      description: '',
    },
    nodes,
    connections: [],
  };
}

function makeNode(type: string): ChartNode {
  return {
    data: {},
    id: `${type}-node` as ChartNode['id'],
    title: type,
    type,
    visualData: {
      x: 0,
      y: 0,
      width: 200,
    },
  };
}

function makeRegistry(owners: Record<string, string | undefined>): PluginUsageRegistry {
  return {
    getPluginFor(type) {
      if (!(type in owners)) {
        throw new Error(`Unknown node type: ${type}`);
      }

      const pluginId = owners[type];
      return pluginId ? { id: pluginId } : undefined;
    },
  };
}

function loadedPluginState(spec: PluginLoadSpec, runtimePluginId: string): PluginUsageState {
  return {
    loaded: true,
    plugin: { id: runtimePluginId },
    spec,
  };
}

describe('pluginUsage', () => {
  test('adds a project plugin spec when a loaded app plugin owns a graph node', () => {
    const project = makeProject([makeGraph('main', [makeNode('examplePluginNode')])]);
    const registry = makeRegistry({ examplePluginNode: 'runtime-plugin-id' });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('uses the active graph overlay when deriving specs from unsaved edits', () => {
    const project = makeProject([makeGraph('main', [])]);
    const currentGraph = makeGraph('main', [makeNode('examplePluginNode')]);
    const registry = makeRegistry({ examplePluginNode: 'runtime-plugin-id' });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        currentGraph,
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('dedupes multiple nodes from the same plugin', () => {
    const project = makeProject([
      makeGraph('main', [makeNode('firstPluginNode'), makeNode('secondPluginNode'), makeNode('firstPluginNode')]),
    ]);
    const registry = makeRegistry({
      firstPluginNode: 'runtime-plugin-id',
      secondPluginNode: 'runtime-plugin-id',
    });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('removes a loaded project plugin spec after all matching nodes are removed', () => {
    const project = makeProject([makeGraph('main', [makeNode('text')])], [pluginSpec]);
    const registry = makeRegistry({ text: undefined });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        project,
        registry,
      }),
      [],
    );
  });

  test('does not add specs for built-in nodes with no plugin owner', () => {
    const project = makeProject([makeGraph('main', [makeNode('text')])]);
    const registry = makeRegistry({ text: undefined });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        project,
        registry,
      }),
      [],
    );
  });

  test('removes stale project plugin specs when all node types are known without them', () => {
    const project = makeProject([makeGraph('main', [makeNode('text')])], [pluginSpec]);
    const registry = makeRegistry({ text: undefined });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [],
        project,
        registry,
      }),
      [],
    );
  });

  test('removes stale built-in project plugin specs when all node types are known without them', () => {
    const project = makeProject([makeGraph('main', [makeNode('text')])], [builtInPluginSpec]);
    const registry = makeRegistry({ text: undefined });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [],
        project,
        registry,
      }),
      [],
    );
  });

  test('preserves unresolved project plugin specs when unknown node types prevent proving usage', () => {
    const project = makeProject([makeGraph('main', [makeNode('unknownPluginNode')])], [pluginSpec]);
    const registry = makeRegistry({});

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [],
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('adds a project plugin spec when a loaded app plugin owns a library node', () => {
    const prefabId = 'prefab-plugin' as NodePrefabId;
    const project = makeProject([makeGraph('main', [])], [], {
      [prefabId]: {
        id: prefabId,
        sourceNode: makeNode('examplePluginNode'),
      },
    });
    const registry = makeRegistry({ examplePluginNode: 'runtime-plugin-id' });

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('preserves failed app plugin specs when unknown node types prevent proving usage', () => {
    const project = makeProject([makeGraph('main', [makeNode('unknownPluginNode')])], [pluginSpec]);
    const registry = makeRegistry({});

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [{ loaded: false, error: 'boom', spec: pluginSpec }],
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('preserves existing specs when unknown node types prevent proving plugin usage', () => {
    const project = makeProject([makeGraph('main', [makeNode('unknownPluginNode')])], [pluginSpec]);
    const registry = makeRegistry({});

    assert.deepEqual(
      deriveProjectPluginSpecsFromGraphs({
        appPluginStates: [loadedPluginState(pluginSpec, 'runtime-plugin-id')],
        project,
        registry,
      }),
      [pluginSpec],
    );
  });

  test('reports project-declared plugins that are not installed in the app', () => {
    assert.deepEqual(getMissingAppPluginSpecs([pluginSpec, builtInPluginSpec], [builtInPluginSpec]), [pluginSpec]);
  });

  test('dedupes duplicate missing project plugin specs', () => {
    assert.deepEqual(getMissingAppPluginSpecs([pluginSpec, pluginSpec], []), [pluginSpec]);
  });

  test('formats and searches plugin specs consistently across app plugin UI', () => {
    assert.equal(getPluginSpecLabel(pluginSpec), '@example/rivet-plugin@latest');
    assert.equal(getPluginSpecDetails(pluginSpec), '@example/rivet-plugin@latest');
    assert.equal(pluginSpecMatchesSearch(pluginSpec, 'EXAMPLE'), true);
    assert.equal(pluginSpecMatchesSearch(pluginSpec, 'missing'), false);
  });
});
