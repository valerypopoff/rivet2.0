import {
  coreCreateProcessor,
  createBuiltInRegistry,
  ExecutionRecorder,
  type ChartNode,
  type GraphId,
  type NodeId,
  type NodeConnection,
  type PortId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';

/** Real Subgraph-produced artifact, intentionally without a top-level start. */
export async function createChildPlaybackFixture(
  nestedCalls = 0,
  outcome: 'complete' | 'fail' | 'abort' | 'prompt' = 'complete',
) {
  const registry = createBuiltInRegistry();
  const text = registry.createDynamic('text');
  text.id = 'child-text' as NodeId;
  text.title = 'Recorded child output';
  text.data = { text: 'child playback evidence' };
  text.visualData = { x: 100, y: 100, width: 260 };
  const nodes: ChartNode[] = [text];
  const connections: NodeConnection[] = [];
  if (outcome === 'fail' || outcome === 'abort') {
    const abort = registry.createDynamic('abortGraph');
    abort.data = { successfully: outcome === 'abort', errorMessage: 'Fixture child failure' };
    nodes.push(abort);
  }
  if (outcome === 'prompt') {
    const prompt = registry.createDynamic('userInput');
    prompt.data = { prompt: 'Historical question', useInput: false };
    prompt.visualData = { x: 450, y: 400, width: 260 };
    nodes.push(prompt);
  }
  const leafInput = registry.createDynamic('graphInput');
  leafInput.data = { id: 'item', dataType: 'string' };
  if (nestedCalls > 0) {
    const items = registry.createDynamic('graphInput');
    items.data = {
      id: 'items',
      dataType: 'string[]',
      defaultValue: Array.from({ length: nestedCalls }, (_, index) => `item ${index}`),
    };
    items.visualData = { x: 100, y: 400, width: 260 };
    const call = registry.createDynamic('subGraph');
    call.id = 'nested-call' as NodeId;
    call.data = { graphId: 'leaf' };
    call.isSplitRun = true;
    call.isSplitSequential = true;
    call.visualData = { x: 400, y: 100, width: 260 };
    nodes.push(items, call);
    connections.push({
      outputNodeId: items.id,
      outputId: 'data' as PortId,
      inputNodeId: call.id,
      inputId: 'item' as PortId,
    });
  }
  const child: Project = {
    metadata: {
      id: 'playback-child' as ProjectId,
      title: 'Child replay',
      description: '',
      mainGraphId: 'main' as GraphId,
    },
    graphs: {
      ['main' as GraphId]: { metadata: { id: 'main' as GraphId, name: 'Child main' }, nodes, connections },
      ['leaf' as GraphId]: {
        metadata: { id: 'leaf' as GraphId, name: 'Repeated leaf' },
        nodes: [{ ...text, id: 'leaf-text' as NodeId }, leafInput],
        connections: [],
      },
    },
    plugins: [],
  };
  const call = registry.createDynamic('subGraph');
  call.data = { graphId: 'main', targetProjectId: child.metadata.id, targetVersion: 'latest' };
  const parent: Project = {
    metadata: { id: 'playback-parent' as ProjectId, title: 'Parent', description: '', mainGraphId: 'main' as GraphId },
    graphs: {
      ['main' as GraphId]: { metadata: { id: 'main' as GraphId, name: 'Parent' }, nodes: [call], connections: [] },
    },
    plugins: [],
  };
  let recording: ExecutionRecorder | undefined;
  const runner = coreCreateProcessor(parent, {
    subgraphProjectLoader: { loadTarget: async () => ({ project: child, revisionKey: 'fixture' }) },
    onSubgraphProjectRun: (run) => {
      recording = run.recorder;
    },
    onUserInput: ({ callback }) => callback({ type: 'string[]', value: ['Historical answer'] }),
  });
  const rootRecording = new ExecutionRecorder();
  rootRecording.record(runner.processor);
  try {
    await runner.run();
    if (outcome === 'fail') throw new Error('Expected fixture run failure');
  } catch (error) {
    if (outcome !== 'fail' || !recording?.events.some((event) => event.type === 'error')) throw error;
  } finally {
    runner.dispose();
  }
  if (!recording) throw new Error('Subgraph did not produce a recording');
  return { child, parent, recording, rootRecording };
}
