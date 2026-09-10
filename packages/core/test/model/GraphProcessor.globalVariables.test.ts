import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeProjectGlobalVariable,
  ExecutionRecorder,
  globalRivetNodeRegistry,
  GraphProcessor,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type PortId,
  type ProcessEvents,
  type Project,
  type ProjectId,
} from '../../src/index.js';
import { testProcessContext } from '../testUtils.js';

function getGlobalNode(id: string, variableId: string) {
  return {
    id: id as NodeId,
    type: 'getGlobal',
    title: 'Get Global',
    data: { id: variableId, useIdInput: false, dataType: 'string', onDemand: false, wait: true },
    visualData: { x: 0, y: 0, width: 200 },
  };
}

function graphOutputNode(id: string, outputId: string) {
  return {
    id: id as NodeId,
    type: 'graphOutput',
    title: 'Graph Output',
    data: { id: outputId, dataType: 'string' },
    visualData: { x: 300, y: 0, width: 200 },
  };
}

function graph(id: string, nodes: NodeGraph['nodes'], connections: NodeGraph['connections']): NodeGraph {
  return {
    metadata: { id: id as GraphId, name: id, description: '' },
    nodes,
    connections,
  };
}

function project(
  id: string,
  mainGraph: NodeGraph,
  globalVariables: Project['metadata']['globalVariables'],
  references: Project['references'] = [],
): Project {
  return {
    metadata: { id: id as ProjectId, title: id, description: '', mainGraphId: mainGraph.metadata.id, globalVariables },
    graphs: { [mainGraph.metadata.id!]: mainGraph },
    plugins: [],
    references,
  };
}

test('assigns authored project global variables before nodes run and records them as global-set lifecycle events', async () => {
  const getter = getGlobalNode('get-greeting', 'greeting');
  const output = graphOutputNode('output-greeting', 'result');
  const mainGraph = graph(
    'main',
    [getter, output],
    [
      {
        outputNodeId: getter.id,
        outputId: 'value' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const processor = new GraphProcessor(
    project('root', mainGraph, { greeting: encodeProjectGlobalVariable({ type: 'string', value: 'hello' }) }),
    mainGraph.metadata.id,
    globalRivetNodeRegistry,
  );
  const events: ProcessEvents['globalSet'][] = [];
  const lifecycle: string[] = [];
  const recorder = new ExecutionRecorder();
  recorder.record(processor);
  processor.on('graphStart', () => lifecycle.push('graphStart'));
  processor.on('globalSet', (event) => events.push(event));
  processor.on('globalSet', () => lifecycle.push('globalSet'));

  const result = await processor.processGraph(testProcessContext());

  assert.deepEqual(result.result, { type: 'string', value: 'hello' });
  assert.deepEqual(
    events.map(({ id, value, processId }) => ({ id, value, processId })),
    [{ id: 'greeting', value: { type: 'string', value: 'hello' }, processId: 'initial-project-global-variable' }],
  );
  assert.deepEqual(lifecycle, ['graphStart', 'globalSet']);

  const recordedProjectGlobalVariableEvents = recorder.events.filter(
    (event) => event.type === 'globalSet' && event.data.processId === 'initial-project-global-variable',
  );
  assert.equal(recordedProjectGlobalVariableEvents.length, 1);

  const replay = new GraphProcessor(
    project('root', mainGraph, { greeting: encodeProjectGlobalVariable({ type: 'string', value: 'hello' }) }),
    mainGraph.metadata.id,
    globalRivetNodeRegistry,
  );
  const replayed: ProcessEvents['globalSet'][] = [];
  replay.on('globalSet', (event) => replayed.push(event));
  await replay.replayRecording(recorder);
  assert.deepEqual(
    replayed.map(({ id, value, processId }) => ({ id, value, processId })),
    [{ id: 'greeting', value: { type: 'string', value: 'hello' }, processId: 'initial-project-global-variable' }],
  );
});

test('interpolation nodes read authored project global variables directly without an input connection', async () => {
  const text = {
    id: 'text' as NodeId,
    type: 'text',
    title: 'Text',
    data: { text: 'Hello {{@globals.profile.user.name}}', normalizeLineEndings: true },
    visualData: { x: 0, y: 0, width: 200 },
  };
  const output = graphOutputNode('output', 'result');
  const mainGraph = graph(
    'main',
    [text, output],
    [
      {
        outputNodeId: text.id,
        outputId: 'output' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const processor = new GraphProcessor(
    project('root', mainGraph, {
      profile: encodeProjectGlobalVariable({ type: 'object', value: { user: { name: 'Rivet' } } }),
    }),
    mainGraph.metadata.id,
    globalRivetNodeRegistry,
  );

  const result = await processor.processGraph(testProcessContext());

  assert.deepEqual(result.result, { type: 'string', value: 'Hello Rivet' });
});

test('a reused root processor refreshes its project global variables rather than retaining an earlier run value', async () => {
  const getter = getGlobalNode('get-greeting', 'greeting');
  const output = graphOutputNode('output-greeting', 'result');
  const mainGraph = graph(
    'main',
    [getter, output],
    [
      {
        outputNodeId: getter.id,
        outputId: 'value' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const rootProject = project('root', mainGraph, {
    greeting: encodeProjectGlobalVariable({ type: 'string', value: 'first value' }),
  });
  const processor = new GraphProcessor(rootProject, mainGraph.metadata.id, globalRivetNodeRegistry);

  assert.deepEqual((await processor.processGraph(testProcessContext())).result, {
    type: 'string',
    value: 'first value',
  });

  rootProject.metadata.globalVariables = {
    greeting: encodeProjectGlobalVariable({ type: 'string', value: 'second value' }),
  };
  assert.deepEqual((await processor.processGraph(testProcessContext())).result, {
    type: 'string',
    value: 'second value',
  });
});

test('Set Global overwrites an authored project global variable and receives its assigned value as the previous value', async () => {
  const text = {
    id: 'new-value' as NodeId,
    type: 'text',
    title: 'Text',
    data: { text: 'changed during run', normalizeLineEndings: true },
    visualData: { x: 0, y: 0, width: 200 },
  };
  const setGlobal = {
    id: 'set-shared' as NodeId,
    type: 'setGlobal',
    title: 'Set Global',
    data: { id: 'shared', useIdInput: false, dataType: 'string' },
    visualData: { x: 250, y: 0, width: 200 },
  };
  const output = graphOutputNode('output-previous', 'previous');
  const mainGraph = graph(
    'main',
    [text, setGlobal, output],
    [
      {
        outputNodeId: text.id,
        outputId: 'output' as PortId,
        inputNodeId: setGlobal.id,
        inputId: 'value' as PortId,
      },
      {
        outputNodeId: setGlobal.id,
        outputId: 'previous-value' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const processor = new GraphProcessor(
    project('root', mainGraph, { shared: encodeProjectGlobalVariable({ type: 'string', value: 'seeded value' }) }),
    mainGraph.metadata.id,
    globalRivetNodeRegistry,
  );

  const result = await processor.processGraph(testProcessContext());

  assert.deepEqual(result.previous, { type: 'string', value: 'seeded value' });
});

test('referenced project global variables are available and root definitions deterministically win collisions', async () => {
  const getter = getGlobalNode('get-shared', 'shared');
  const output = graphOutputNode('output-shared', 'result');
  const mainGraph = graph(
    'main',
    [getter, output],
    [
      {
        outputNodeId: getter.id,
        outputId: 'value' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const childGraph = graph('child-graph', [], []);
  const child = project('child', childGraph, {
    shared: encodeProjectGlobalVariable({ type: 'string', value: 'from child' }),
  });
  const root = project('root', mainGraph, { shared: encodeProjectGlobalVariable({ type: 'string', value: 'from root' }) }, [
    { id: child.metadata.id },
  ]);
  const processor = new GraphProcessor(root, mainGraph.metadata.id, globalRivetNodeRegistry);

  const result = await processor.processGraph({
    ...testProcessContext(),
    projectReferenceLoader: {
      async loadProject() {
        return child;
      },
    },
  });

  assert.deepEqual(result.result, { type: 'string', value: 'from root' });
});

test('a legacy child-to-root reference back-edge reuses the root instead of reloading it', async () => {
  const getter = getGlobalNode('get-shared', 'shared');
  const output = graphOutputNode('output-shared', 'result');
  const mainGraph = graph(
    'main',
    [getter, output],
    [
      {
        outputNodeId: getter.id,
        outputId: 'value' as PortId,
        inputNodeId: output.id,
        inputId: 'value' as PortId,
      },
    ],
  );
  const child = project(
    'child',
    graph('child-graph', [], []),
    { shared: encodeProjectGlobalVariable({ type: 'string', value: 'from child' }) },
    [{ id: 'root' as ProjectId }],
  );
  const root = project('root', mainGraph, { shared: encodeProjectGlobalVariable({ type: 'string', value: 'from root' }) }, [
    { id: child.metadata.id },
  ]);
  const processor = new GraphProcessor(root, mainGraph.metadata.id, globalRivetNodeRegistry);
  const requestedReferenceIds: string[] = [];

  const result = await processor.processGraph({
    ...testProcessContext(),
    projectReferenceLoader: {
      async loadProject(_path, reference) {
        requestedReferenceIds.push(reference.id);
        assert.equal(reference.id, child.metadata.id);
        return child;
      },
    },
  });

  assert.deepEqual(requestedReferenceIds, [child.metadata.id]);
  assert.deepEqual(result.result, { type: 'string', value: 'from root' });
});

test('rejects a reference loader that returns a different project identity', async () => {
  const output = graphOutputNode('output', 'result');
  const mainGraph = graph('main', [output], []);
  const root = project('root', mainGraph, {}, [{ id: 'expected-child' as ProjectId }]);
  const mismatched = project('actual-child', graph('child', [], []), {});
  const processor = new GraphProcessor(root, mainGraph.metadata.id, globalRivetNodeRegistry);

  await assert.rejects(
    () =>
      processor.processGraph({
        ...testProcessContext(),
        projectReferenceLoader: {
          async loadProject() {
            return mismatched;
          },
        },
      }),
    /expected-child.*actual-child/,
  );
});
