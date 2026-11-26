import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  coreCreateProcessor,
  createBuiltInRegistry,
  ExecutionRecorder,
  readSubgraphTargetDisplaySnapshots,
  type ChartNode,
  type GraphId,
  type NodeId,
  type Project,
  type ProjectId,
  type NodePrefabId,
  type SubgraphProjectRun,
} from '../../src/index.js';

void it('copies only valid optional target display fields', () => {
  const valid = {
    nodeId: 'caller',
    targetProjectId: 'target',
    targetVersion: 'latest',
    targetGraphId: 'graph',
    projectName: '项目 / Project',
    graphName: 'folder/Graph',
    ignored: { private: true },
  };
  for (const input of [undefined, null, 42, 'metadata', {}]) {
    assert.equal(readSubgraphTargetDisplaySnapshots(input), undefined);
  }
  const invalid = [
    null,
    [],
    {},
    { ...valid, targetVersion: 'wrong' },
    { ...valid, targetVersion: undefined },
    { ...valid, projectName: null },
    { ...valid, graphName: 1 },
    { ...valid, projectName: ' ', graphName: '' },
    ...['nodeId', 'targetProjectId', 'targetGraphId'].flatMap((key) =>
      [undefined, 42, ' '].map((value) => ({ ...valid, [key]: value })),
    ),
  ];
  assert.equal(readSubgraphTargetDisplaySnapshots(invalid), undefined);
  const copied = readSubgraphTargetDisplaySnapshots([
    ...invalid,
    valid,
    { ...valid, nodeId: 'partial', projectName: '  ', graphName: 'Only graph' },
  ])!;
  assert.deepEqual(copied, [
    {
      nodeId: 'caller',
      targetProjectId: 'target',
      targetVersion: 'latest',
      targetGraphId: 'graph',
      projectName: '项目 / Project',
      graphName: 'folder/Graph',
    },
    {
      nodeId: 'partial',
      targetProjectId: 'target',
      targetVersion: 'latest',
      targetGraphId: 'graph',
      graphName: 'Only graph',
    },
  ]);
  valid.projectName = 'Changed';
  assert.equal(copied[0]!.projectName, '项目 / Project');
});

void it('captures resolved versions and prefab instance IDs without leaking descendants or stale runs', async () => {
  const registry = createBuiltInRegistry();
  const text = registry.createDynamic('text');
  text.id = 'plain' as NodeId;
  text.data = { text: 'unchanged result' };
  const call = (id: string, projectId: string, version: 'latest' | 'published' = 'latest') => {
    const node = registry.createDynamic('subGraph');
    node.id = id as NodeId;
    node.data = { graphId: 'main', targetProjectId: projectId, targetVersion: version };
    return node;
  };
  const project = (id: string, title: string, graphName: string, nodes: ChartNode[]): Project => ({
    metadata: { id: id as ProjectId, title, description: '', mainGraphId: 'main' as GraphId },
    graphs: { ['main' as GraphId]: { metadata: { id: 'main' as GraphId, name: graphName }, nodes, connections: [] } },
  });
  const disabled = { ...call('disabled', 'missing'), disabled: true };
  const parent = project('parent', 'Parent', 'Caller', [
    call('latest', 'target'),
    {
      id: 'published-instance',
      type: 'nodePrefabInstance',
      data: { prefabId: 'published-prefab' },
      visualData: { x: 0, y: 0 },
    } as ChartNode,
    disabled,
    text,
  ]);
  parent.nodePrefabs = {
    ['published-prefab' as NodePrefabId]: {
      id: 'published-prefab' as NodePrefabId,
      sourceNode: call('source-node', 'target', 'published'),
    },
  };
  let generation = 1;
  let fail = false;
  let unreadableTitle = false;
  let titleReads = 0;
  const loads: string[] = [];
  const validations: string[] = [];
  const children: SubgraphProjectRun[] = [];
  const resolved = new Map<string, Project>();
  const runner = coreCreateProcessor(parent, {
    subgraphProjectLoader: {
      loadTarget: async (target) => {
        loads.push(`${target.projectId}:${target.version}`);
        if (fail) throw new Error('Target denied during preparation');
        assert.notEqual(target.projectId, 'missing');
        const child =
          target.projectId === 'grandchild'
            ? project('grandchild', `Grandchild ${generation}`, 'Nested graph', [text])
            : project(
                'target',
                `${target.version} title ${generation}`,
                `folder/${target.version} graph ${generation}`,
                [call('nested', 'grandchild')],
              );
        if (unreadableTitle)
          Object.defineProperty(child.metadata, 'title', {
            get() {
              titleReads++;
              throw new Error('Display getter must not affect execution');
            },
          });
        resolved.set(`${target.projectId}:${target.version}`, child);
        return { project: child };
      },
      validateTarget: async (target) => {
        validations.push(`${target.projectId}:${target.callerProjectId}`);
      },
    },
    onSubgraphProjectRun: (run) => {
      children.push(run);
    },
  });
  const capture = () => {
    const recorder = new ExecutionRecorder();
    recorder.record(runner.processor);
    return recorder;
  };
  const targets = (recorder: ExecutionRecorder) =>
    recorder.events.find((event) => event.type === 'graphStart')?.data.subgraphTargets;
  const original = structuredClone(parent);
  try {
    const first = capture();
    const channel = Object.assign(new EventTarget(), { readyState: 1 });
    const socketRecording = new ExecutionRecorder();
    const socketDone = socketRecording.recordSocket(channel, { requestId: 'root-recording' });
    const stopForwarding = runner.processor.onAny((message, data) => {
      if (message === 'finish') return;
      channel.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ message, data, requestId: 'root-recording' }) }),
      );
    });
    try {
      await runner.run();
      await socketDone;
    } finally {
      stopForwarding();
      channel.dispatchEvent(new Event('close'));
    }
    assert.deepEqual(targets(first), [
      {
        nodeId: 'latest',
        targetProjectId: 'target',
        targetVersion: 'latest',
        targetGraphId: 'main',
        projectName: 'latest title 1',
        graphName: 'folder/latest graph 1',
      },
      {
        nodeId: 'published-instance',
        targetProjectId: 'target',
        targetVersion: 'published',
        targetGraphId: 'main',
        projectName: 'published title 1',
        graphName: 'folder/published graph 1',
      },
    ]);
    const graphStarts = (recorder: ExecutionRecorder) =>
      recorder.events.filter((event) => event.type === 'graphStart').map((event) => event.data);
    assert.deepEqual(graphStarts(socketRecording), JSON.parse(JSON.stringify(graphStarts(first))));
    assert.deepEqual(
      socketRecording.events.find((event) => event.type === 'done')?.data,
      first.events.find((event) => event.type === 'done')?.data,
    );
    assert.deepEqual(loads, ['target:latest', 'grandchild:latest', 'target:published']);
    assert.ok(validations.includes('grandchild:target'), 'Cached targets still recheck their actual caller');
    assert.deepEqual(parent, original);
    assert.equal(
      first.events.some((event) => event.type === 'graphStart' && event.data.execution?.projectScope),
      false,
    );
    const child = children.find((run) => run.target.projectId === 'target')!;
    assert.equal(
      child.recorder.events.some((event) => event.type === 'start'),
      false,
    );
    assert.equal(targets(child.recorder)?.[0]?.projectName, 'Grandchild 1');
    assert.equal(targets(child.recorder)?.[0]?.nodeId, 'nested');

    for (const restored of [
      ExecutionRecorder.deserializeFromString(first.serialize()),
      await ExecutionRecorder.deserializeFromStream(first.serializeStream()),
    ]) {
      assert.deepEqual(restored.events, JSON.parse(JSON.stringify(first.events)));
    }
    const withoutNames = JSON.parse(first.serialize());
    for (const event of withoutNames.recording.events) {
      if (event.type === 'graphStart') delete event.data.subgraphTargets;
    }
    const replay = async (recorder: ExecutionRecorder) => {
      const events: string[] = [];
      const unsubscribe = runner.processor.onAny((name) => {
        events.push(name);
      });
      try {
        return { outputs: await runner.processor.replayRecording(recorder), events };
      } finally {
        unsubscribe();
      }
    };
    assert.deepEqual(
      await replay(first),
      await replay(ExecutionRecorder.deserializeFromString(JSON.stringify(withoutNames))),
    );
    resolved.get('target:latest')!.metadata.title = 'Mutated later';
    assert.equal(targets(first)?.[0]?.projectName, 'latest title 1');
    generation++;
    const second = capture();
    await runner.run();
    assert.equal(targets(second)?.[0]?.projectName, 'latest title 2');
    assert.equal(loads.filter((key) => key === 'target:latest').length, 2);

    fail = true;
    const failed = capture();
    await assert.rejects(runner.run(), /Target denied during preparation/);
    assert.equal(targets(failed), undefined);
    assert.equal(targets(first)?.[0]?.projectName, 'latest title 1');

    fail = false;
    unreadableTitle = true;
    const captionless = capture();
    await runner.run();
    assert.equal(titleReads, 0);
    assert.equal(targets(captionless)?.[0]?.projectName, undefined);
    assert.equal(targets(captionless)?.[0]?.graphName, 'folder/latest graph 2');
    unreadableTitle = false;
    runner.processor.runToNodeIds = ['plain' as NodeId];
    const before = children.length;
    const excluded = capture();
    await runner.run();
    assert.equal(children.length, before);
    assert.equal(targets(excluded)?.length, 2, 'Names from preparation do not claim that the calls ran');
  } finally {
    runner.dispose();
  }
});
