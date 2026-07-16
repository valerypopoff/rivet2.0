import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  getGraphBoundary,
  initializeUiGraphChatActionBindings,
  initializeUiGraphRunGraphActionBindings,
  reconcileUiGraphChatActionBindings,
  reconcileProjectUiGraphButtonBindings,
  reconcileProjectUiGraphBindings,
  reconcileUiGraphRunGraphActionBindings,
  validateProjectUiGraphButtonBindings,
  validateUiGraphButtonBindings,
  validateUiGraphActionBindings,
  type GraphBoundary,
  type GraphId,
  type NodeId,
  type NodeGraph,
  type PortId,
  type Project,
  type UiGraph,
  type UiGraphId,
} from '../../src/index.js';

const graphId = 'graph' as GraphId;
const uiGraphId = 'ui-graph' as UiGraphId;

void describe('UI graph button bindings', () => {
  void it('uses ordered placeholder data keys only when initializing a new button', () => {
    const boundary = getGraphBoundary(
      makeProject(makeBoundaryGraph({ input: 'question', output: 'response' })),
      graphId,
    )!;
    const action = initializeUiGraphRunGraphActionBindings(
      {
        graphId,
        inputMappings: [{ inputKey: 'input', stateKey: 'input' }],
        outputs: [{ stateKey: 'result' }],
        type: 'runGraph',
      },
      boundary,
    );

    assert.deepEqual(action.inputMappings, [{ inputKey: 'question', stateKey: 'input' }]);
    assert.deepEqual(action.outputs, [{ outputKey: 'response', stateKey: 'result' }]);
  });

  void it('initializes, validates, and reconciles Chat graph roles by boundary identity', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'message', output: 'answer' }));
    const next = makeProject(makeBoundaryGraph({ input: 'question', output: 'response' }));
    addGraphInput(previous.graphs[graphId]!, 'history', 'history-input');
    addGraphInput(next.graphs[graphId]!, 'history', 'history-input');
    const boundary = getGraphBoundary(previous, graphId)!;
    const initialized = initializeUiGraphChatActionBindings({ graphId, type: 'runGraph' }, boundary);

    assert.deepEqual(initialized, {
      graphId,
      historyInputId: 'history',
      responseOutputId: 'answer',
      type: 'runGraph',
      userInputId: 'message',
    });
    assert.deepEqual(
      initializeUiGraphChatActionBindings(
        { graphId, type: 'runGraph' },
        {
          inputs: boundary.inputs
            .filter((input) => input.id !== 'history')
            .concat({
              dataType: 'string' as const,
              id: 'prompt',
              portId: 'prompt' as PortId,
            }),
          outputs: boundary.outputs,
        },
      ),
      {
        graphId,
        historyInputId: 'prompt',
        responseOutputId: 'answer',
        type: 'runGraph',
        userInputId: 'message',
      },
    );
    assert.deepEqual(
      initializeUiGraphChatActionBindings(
        { graphId, type: 'runGraph' },
        {
          inputs: [
            { dataType: 'string', id: 'history', portId: 'history' as PortId },
            { dataType: 'chat-message[]', id: 'chatContext', portId: 'chat-context' as PortId },
            { dataType: 'string', id: 'prompt', portId: 'prompt' as PortId },
          ],
          outputs: boundary.outputs,
        },
      ),
      {
        graphId,
        historyInputId: 'chatContext',
        responseOutputId: 'answer',
        type: 'runGraph',
        userInputId: 'prompt',
      },
    );

    addGraphInput(previous.graphs[graphId]!, 'tone', 'tone-input', 'string');
    addGraphInput(next.graphs[graphId]!, 'style', 'tone-input', 'string');
    const initializedWithAdditionalInput = {
      ...initialized,
      inputMappings: [{ inputKey: 'tone', stateKey: 'selectedTone' }],
    };
    for (const project of [previous, next]) {
      project.uiGraphs![uiGraphId]!.components = [
        {
          action: initializedWithAdditionalInput,
          id: 'chat' as any,
          type: 'chat',
        },
      ];
    }

    const reconciled = reconcileProjectUiGraphBindings(previous, next);
    const chat = reconciled.uiGraphs![uiGraphId]!.components[0]!;
    assert.equal(chat.type, 'chat');
    assert.deepEqual(chat.action, {
      graphId,
      historyInputId: 'history',
      inputMappings: [{ inputKey: 'style', stateKey: 'selectedTone' }],
      responseOutputId: 'response',
      type: 'runGraph',
      userInputId: 'question',
    });
    assert.deepEqual(validateUiGraphActionBindings(reconciled, reconciled.uiGraphs![uiGraphId]!), []);

    chat.action.historyInputId = chat.action.userInputId;
    assert.deepEqual(
      validateUiGraphActionBindings(reconciled, reconciled.uiGraphs![uiGraphId]!).map((issue) => issue.code),
      ['duplicate-chat-input'],
    );
  });

  void it('reports invalid Chat additional input mappings without mutating them', () => {
    const project = makeProject(makeBoundaryGraph({ input: 'message', output: 'answer' }));
    addGraphInput(project.graphs[graphId]!, 'history', 'history-input');
    addGraphInput(project.graphs[graphId]!, 'tone', 'tone-input', 'string');
    const uiGraph = project.uiGraphs![uiGraphId]!;
    uiGraph.components = [
      {
        action: {
          graphId,
          historyInputId: 'history',
          inputMappings: [
            { inputKey: 'message', stateKey: 'duplicate' },
            { inputKey: 'missing', stateKey: 'missing' },
            { inputKey: 'tone', stateKey: '' },
            { inputKey: '', stateKey: '' },
          ],
          responseOutputId: 'answer',
          type: 'runGraph',
          userInputId: 'message',
        },
        id: 'chat' as any,
        type: 'chat',
      },
    ];
    const before = structuredClone(uiGraph.components[0]);

    assert.deepEqual(
      validateUiGraphActionBindings(project, uiGraph).map((issue) => issue.code),
      [
        'duplicate-input-binding',
        'stale-input-binding',
        'empty-input-state-key',
        'empty-input-id',
        'empty-input-state-key',
      ],
    );
    assert.deepEqual(uiGraph.components[0], before);
  });

  void it('preserves unfinished Chat input rows and clears only stale configured IDs', () => {
    const project = makeProject(makeBoundaryGraph({ input: 'message', output: 'answer' }));
    addGraphInput(project.graphs[graphId]!, 'history', 'history-input');
    const boundary = getGraphBoundary(project, graphId)!;

    const action = reconcileUiGraphChatActionBindings(
      {
        graphId,
        historyInputId: 'history',
        inputMappings: [
          { inputKey: '', stateKey: '' },
          { inputKey: '', stateKey: 'futureValue' },
          { inputKey: 'removed', stateKey: 'oldValue' },
        ],
        responseOutputId: 'answer',
        type: 'runGraph',
        userInputId: 'message',
      },
      boundary,
    );

    assert.deepEqual(action.inputMappings, [
      { inputKey: '', stateKey: '' },
      { inputKey: '', stateKey: 'futureValue' },
      { inputKey: '', stateKey: 'oldValue' },
    ]);
  });

  void it('keeps generated output data keys unique', () => {
    const boundary: GraphBoundary = {
      inputs: [],
      outputs: ['answer', 'result'].map((id) => ({
        dataType: 'string',
        id,
        nodeId: `${id}-node` as NodeId,
        portId: id as PortId,
      })),
    };
    const initialized = initializeUiGraphRunGraphActionBindings(
      { graphId, outputs: [{ stateKey: 'result' }], type: 'runGraph' },
      boundary,
    );
    const reconciled = reconcileUiGraphRunGraphActionBindings(
      { graphId, outputs: [{ outputKey: 'answer', stateKey: 'result' }], type: 'runGraph' },
      boundary,
    );

    assert.deepEqual(initialized.outputs, [
      { outputKey: 'answer', stateKey: 'result' },
      { outputKey: 'result', stateKey: 'result-2' },
    ]);
    assert.deepEqual(reconciled.outputs, [
      { outputKey: 'answer', stateKey: 'result' },
      { outputKey: 'result', stateKey: 'result-2' },
    ]);
  });

  void it('allows separate buttons to write the same UI data key', () => {
    const project = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const uiGraph = project.uiGraphs![uiGraphId]!;
    const firstButton = uiGraph.components[0]!;
    assert.equal(firstButton.type, 'button');
    uiGraph.components.push({
      ...firstButton,
      id: 'second-button' as any,
      action: structuredClone(firstButton.action),
    });

    assert.deepEqual(validateUiGraphActionBindings(project, uiGraph), []);
  });

  void it('reports a blank saved output mapping without treating another button key as the cause', () => {
    const project = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const uiGraph = project.uiGraphs![uiGraphId]!;
    const firstButton = uiGraph.components[0]!;
    assert.equal(firstButton.type, 'button');
    uiGraph.components.push({
      ...firstButton,
      id: 'broken-button' as any,
      action: {
        ...firstButton.action,
        outputs: [{ outputKey: 'answer', stateKey: '' }],
      },
    });

    assert.deepEqual(
      validateUiGraphActionBindings(project, uiGraph, 'broken-button' as any).map((issue) => issue.code),
      ['empty-output-state-key'],
    );
  });

  void it('preserves data keys for exact IDs and proven same-node renames', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const next = makeProject(makeBoundaryGraph({ input: 'question', output: 'response' }));
    const reconciled = reconcileProjectUiGraphButtonBindings(previous, next);
    const action = getButtonAction(reconciled);

    assert.deepEqual(action.inputMappings, [{ inputKey: 'question', stateKey: 'formPrompt' }]);
    assert.deepEqual(action.outputs, [{ outputKey: 'response', stateKey: 'result' }]);
    assert.notEqual(reconciled, next);
    assert.deepEqual(getButtonAction(next).inputMappings, [{ inputKey: 'prompt', stateKey: 'formPrompt' }]);
  });

  void it('does not carry a data key by position when one port is replaced by another', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', inputNodeId: 'old-input' }));
    const next = makeProject(makeBoundaryGraph({ input: 'question', inputNodeId: 'new-input' }));
    const reconciled = reconcileProjectUiGraphButtonBindings(previous, next);

    assert.deepEqual(getButtonAction(reconciled).inputMappings, [{ inputKey: 'question', stateKey: 'question' }]);
  });

  void it('preserves literal legacy inputs while renaming their graph input key', () => {
    const boundary = getGraphBoundary(makeProject(makeBoundaryGraph({ input: 'question' })), graphId)!;
    const action = reconcileUiGraphRunGraphActionBindings(
      {
        graphId,
        inputs: { prompt: { type: 'literal', value: { nested: true } } },
        type: 'runGraph',
      },
      boundary,
      { inputIds: { prompt: 'question' } },
    );

    assert.deepEqual(action.inputs, { question: { type: 'literal', value: { nested: true } } });
    assert.equal(action.inputMappings, undefined);
  });

  void it('preserves all-output bindings while reconciling additional specific outputs', () => {
    const boundary = getGraphBoundary(
      makeProject(makeBoundaryGraph({ input: 'question', output: 'response' })),
      graphId,
    )!;
    const action = reconcileUiGraphRunGraphActionBindings(
      {
        graphId,
        outputs: [{ stateKey: 'allResults' }, { outputKey: 'answer', stateKey: 'answerOnly' }],
        type: 'runGraph',
      },
      boundary,
      { outputIds: { answer: 'response' } },
    );

    assert.deepEqual(action.outputs, [
      { outputKey: undefined, stateKey: 'allResults' },
      { outputKey: 'response', stateKey: 'answerOnly' },
    ]);
  });

  void it('preserves output fan-out across a proven output rename', () => {
    const boundary = getGraphBoundary(
      makeProject(makeBoundaryGraph({ input: 'question', output: 'response' })),
      graphId,
    )!;
    const action = reconcileUiGraphRunGraphActionBindings(
      {
        graphId,
        outputs: [
          { outputKey: 'answer', stateKey: 'summary' },
          { outputKey: 'answer', stateKey: 'rawAnswer' },
        ],
        type: 'runGraph',
      },
      boundary,
      { outputIds: { answer: 'response' } },
    );

    assert.deepEqual(action.outputs, [
      { outputKey: 'response', stateKey: 'summary' },
      { outputKey: 'response', stateKey: 'rawAnswer' },
    ]);
  });

  void it('leaves ambiguous bindings for preflight instead of silently repairing them', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const next = makeProject(makeBoundaryGraph({ input: 'question', output: 'response' }));
    const button = next.uiGraphs![uiGraphId]!.components[0]!;
    assert.equal(button.type, 'button');
    button.action.inputMappings = [
      { inputKey: 'prompt', stateKey: 'firstPrompt' },
      { inputKey: 'prompt', stateKey: 'secondPrompt' },
    ];

    assert.equal(reconcileProjectUiGraphButtonBindings(previous, next), next);
    assert.deepEqual(getButtonAction(next).outputs, [{ outputKey: 'answer', stateKey: 'result' }]);
    assert.ok(validateProjectUiGraphButtonBindings(next).some((issue) => issue.code === 'duplicate-input-binding'));
  });

  void it('preserves intentionally omitted mappings across boundary changes', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const next = makeProject(makeBoundaryGraph({ input: 'question', output: 'response' }));
    const button = next.uiGraphs![uiGraphId]!.components[0]!;
    assert.equal(button.type, 'button');
    button.action = { graphId, type: 'runGraph' };

    assert.equal(reconcileProjectUiGraphButtonBindings(previous, next), next);
    assert.deepEqual(getButtonAction(next), { graphId, type: 'runGraph' });
    assert.deepEqual(validateProjectUiGraphButtonBindings(next), []);
  });

  void it('reconciles only the changed side of a graph boundary', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const next = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'response' }));
    const button = next.uiGraphs![uiGraphId]!.components[0]!;
    assert.equal(button.type, 'button');
    button.action = {
      graphId,
      inputs: { prompt: { key: 'formPrompt', type: 'state' } },
      outputs: [{ outputKey: 'answer', stateKey: 'result' }],
      type: 'runGraph',
    };

    const action = getButtonAction(reconcileProjectUiGraphButtonBindings(previous, next));

    assert.deepEqual(action.inputs, { prompt: { key: 'formPrompt', type: 'state' } });
    assert.equal(action.inputMappings, undefined);
    assert.deepEqual(action.outputs, [{ outputKey: 'response', stateKey: 'result' }]);
  });

  void it('adds new ports when the button covered the complete previous boundary', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const nextGraph = makeBoundaryGraph({ input: 'prompt', output: 'answer' });
    nextGraph.nodes.push(
      {
        data: { dataType: 'string', id: 'context' },
        id: 'context-input' as any,
        title: 'Context',
        type: 'graphInput',
        visualData: { x: 0, y: 100 },
      } as any,
      {
        data: { dataType: 'string', id: 'score' },
        id: 'score-output' as any,
        title: 'Score',
        type: 'graphOutput',
        visualData: { x: 300, y: 100 },
      } as any,
    );

    const action = getButtonAction(reconcileProjectUiGraphButtonBindings(previous, makeProject(nextGraph)));

    assert.deepEqual(action.inputMappings, [
      { inputKey: 'context', stateKey: 'context' },
      { inputKey: 'prompt', stateKey: 'formPrompt' },
    ]);
    assert.deepEqual(action.outputs, [
      { outputKey: 'answer', stateKey: 'result' },
      { outputKey: 'score', stateKey: 'score' },
    ]);
  });

  void it('leaves projects unchanged when graph boundary IDs did not change', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const next = { ...previous, graphs: { ...previous.graphs } };

    assert.equal(reconcileProjectUiGraphButtonBindings(previous, next), next);
  });

  void it('retains unaffected UI graph references when another app is reconciled', () => {
    const previous = makeProject(makeBoundaryGraph({ input: 'prompt', output: 'answer' }));
    const next = makeProject(makeBoundaryGraph({ input: 'question', output: 'response' }));
    const otherUiGraphId = 'other-ui-graph' as UiGraphId;
    const otherUiGraph: UiGraph = {
      components: [{ id: 'text' as any, text: 'Unaffected', type: 'text' }],
      id: otherUiGraphId,
      name: 'Other app',
    };
    previous.uiGraphs![otherUiGraphId] = otherUiGraph;
    next.uiGraphs![otherUiGraphId] = otherUiGraph;

    const reconciled = reconcileProjectUiGraphButtonBindings(previous, next);

    assert.notEqual(reconciled.uiGraphs![uiGraphId], next.uiGraphs![uiGraphId]);
    assert.equal(reconciled.uiGraphs![otherUiGraphId], otherUiGraph);
  });

  void it('reports stale mappings without mutating the project', () => {
    const project = makeProject(makeBoundaryGraph({ input: 'question', output: 'response' }));
    const uiGraph = project.uiGraphs![uiGraphId]!;
    const before = structuredClone(project);
    const issues = validateUiGraphButtonBindings(project, uiGraph);

    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.severity]),
      [
        ['stale-input-binding', 'error'],
        ['stale-output-binding', 'error'],
      ],
    );
    assert.deepEqual(project, before);
    assert.deepEqual(validateProjectUiGraphButtonBindings(project), issues);
  });
});

function makeProject(graph: NodeGraph): Project {
  const uiGraph: UiGraph = {
    components: [
      {
        action: {
          graphId,
          inputMappings: [{ inputKey: 'prompt', stateKey: 'formPrompt' }],
          outputs: [{ outputKey: 'answer', stateKey: 'result' }],
          type: 'runGraph',
        },
        id: 'button' as any,
        label: 'Run',
        type: 'button',
      },
    ],
    id: uiGraphId,
    name: 'App',
  };

  return {
    graphs: { [graphId]: graph },
    metadata: { description: '', id: 'project' as any, title: 'Project' },
    uiGraphs: { [uiGraphId]: uiGraph },
  };
}

function makeBoundaryGraph(options: {
  input: string;
  inputNodeId?: string;
  output?: string;
  outputNodeId?: string;
}): NodeGraph {
  return {
    connections: [],
    metadata: { description: '', id: graphId, name: 'Graph' },
    nodes: [
      {
        data: { dataType: 'string', id: options.input },
        id: (options.inputNodeId ?? 'input-node') as any,
        title: 'Input',
        type: 'graphInput',
        visualData: { x: 0, y: 0 },
      } as any,
      ...(options.output
        ? [
            {
              data: { dataType: 'string', id: options.output },
              id: (options.outputNodeId ?? 'output-node') as any,
              title: 'Output',
              type: 'graphOutput',
              visualData: { x: 300, y: 0 },
            } as any,
          ]
        : []),
    ],
  };
}

function addGraphInput(
  graph: NodeGraph,
  id: string,
  nodeId: string,
  dataType: 'chat-message[]' | 'string' = 'chat-message[]',
): void {
  graph.nodes.push({
    data: { dataType, id },
    id: nodeId as any,
    title: id,
    type: 'graphInput',
    visualData: { x: 0, y: 100 },
  } as any);
}

function getButtonAction(project: Project) {
  const component = project.uiGraphs![uiGraphId]!.components[0]!;
  assert.equal(component.type, 'button');
  return component.action;
}
