import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  type ChartNode,
  type GraphId,
  type NodeGraph,
  type Project,
  type ProjectId,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import {
  getGraphIdsReferencingGraph,
  getGraphReachabilityReport,
  getUiGraphIdsReferencingGraph,
  resolveSupportedBuiltInPluginIds,
  type GraphReachabilityRegistry,
} from './graphReachability.js';

function makeNode(
  type: string,
  data: Record<string, unknown>,
  options: { id?: string; disabled?: boolean } = {},
): ChartNode {
  return {
    id: (options.id ?? `${type}-node`) as any,
    type,
    title: type,
    visualData: { x: 0, y: 0 },
    data,
    disabled: options.disabled,
  };
}

function makeConnection(outputNodeId: string, inputNodeId: string, outputId: string, inputId: string) {
  return {
    outputNodeId: outputNodeId as any,
    inputNodeId: inputNodeId as any,
    outputId: outputId as any,
    inputId: inputId as any,
  };
}

function makeGraph(
  id: string,
  name: string,
  nodes: ChartNode[] = [],
  connections: NodeGraph['connections'] = [],
): NodeGraph {
  return {
    metadata: {
      id: id as GraphId,
      name,
      description: '',
    },
    nodes,
    connections,
  };
}

function makeProject(
  graphs: NodeGraph[],
  mainGraphId?: string,
  uiGraphs?: Record<UiGraphId, UiGraph>,
): Pick<Project, 'metadata' | 'graphs' | 'uiGraphs'> {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: '',
      mainGraphId: mainGraphId as GraphId | undefined,
    },
    graphs: Object.fromEntries(graphs.map((graph) => [graph.metadata!.id!, graph])),
    uiGraphs,
  };
}

function makeUiGraph(id: string, components: UiGraph['components']): UiGraph {
  return {
    id: id as UiGraphId,
    name: id,
    components,
  };
}

function makeButton(id: string, graphId: string): Extract<UiGraph['components'][number], { type: 'button' }> {
  return {
    id: id as UiComponentId,
    type: 'button',
    label: 'Run',
    action: { type: 'runGraph', graphId: graphId as GraphId },
  };
}

function makeChat(id: string, graphId: string): Extract<UiGraph['components'][number], { type: 'chat' }> {
  return {
    id: id as UiComponentId,
    type: 'chat',
    action: { type: 'runGraph', graphId: graphId as GraphId },
  };
}

function sortGraphIds(graphIds: Set<GraphId>): string[] {
  return [...graphIds].sort();
}

function makeRegistry(options: {
  registeredTypes: string[];
  pluginByType?: Record<string, string>;
}): GraphReachabilityRegistry {
  const registeredTypes = new Set(options.registeredTypes);
  const pluginByType = options.pluginByType ?? {};

  return {
    isRegistered(type) {
      return registeredTypes.has(type);
    },
    getPluginFor(type) {
      const pluginId = pluginByType[type];
      return pluginId ? { id: pluginId } : undefined;
    },
  };
}

describe('graphReachability', () => {
  test('uses the Main Graph as the default reachability root', () => {
    const main = makeGraph('main', 'Main');
    const spare = makeGraph('spare', 'Spare');

    const report = getGraphReachabilityReport(makeProject([main, spare], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['spare']);
    assert.equal(report.status, 'ready');
    assert.deepEqual(report.warnings, []);
  });

  test('treats Button and Chat web-app targets as definite reachability roots', () => {
    const main = makeGraph('main', 'Main');
    const appLeaf = makeGraph('app-leaf', 'App Leaf');
    const buttonTarget = makeGraph('button-target', 'Button Target', [
      makeNode('subGraph', { graphId: 'app-leaf' as GraphId }),
    ]);
    const chatTarget = makeGraph('chat-target', 'Chat Target');
    const spare = makeGraph('spare', 'Spare');
    const webApp = makeUiGraph('web-app', [makeButton('button', 'button-target'), makeChat('chat', 'chat-target')]);

    const report = getGraphReachabilityReport(
      makeProject([main, buttonTarget, appLeaf, chatTarget, spare], 'main', { [webApp.id]: webApp }),
    );

    assert.deepEqual(sortGraphIds(report.definite), ['app-leaf', 'button-target', 'chat-target', 'main']);
    assert.deepEqual(sortGraphIds(report.unreachable), ['spare']);
  });

  test('keeps reachability blocked without a valid Main Graph even when a web app has an action target', () => {
    const target = makeGraph('target', 'Target');
    const webApp = makeUiGraph('web-app', [makeButton('button', 'target')]);

    const report = getGraphReachabilityReport(makeProject([target], undefined, { [webApp.id]: webApp }));

    assert.equal(report.status, 'blocked');
    assert.equal(report.blockedReason, 'missing-main-graph');
    assert.deepEqual(sortGraphIds(report.definite), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['target']);
  });

  test('follows direct static executors transitively', () => {
    const leaf = makeGraph('leaf', 'Leaf');
    const looped = makeGraph('looped', 'Looped', [makeNode('loopUntil', { targetGraph: 'leaf' as GraphId })]);
    const main = makeGraph('main', 'Main', [makeNode('subGraph', { graphId: 'looped' as GraphId })]);

    const report = getGraphReachabilityReport(makeProject([main, looped, leaf], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['leaf', 'looped', 'main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), []);
  });

  test('treats an immediate static Graph Reference into Call Graph as definite', () => {
    const reference = makeNode(
      'graphReference',
      {
        graphId: 'target' as GraphId,
        useGraphIdOrNameInput: false,
      },
      { id: 'ref' },
    );
    const callGraph = makeNode('callGraph', {}, { id: 'call' });
    const main = makeGraph('main', 'Main', [reference, callGraph], [makeConnection('ref', 'call', 'graph', 'graph')]);
    const target = makeGraph('target', 'Target');

    const report = getGraphReachabilityReport(makeProject([main, target], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main', 'target']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
  });

  test('marks non-static Call Graph provenance as dynamic and propagates that state', () => {
    const dynamicReference = makeNode(
      'graphReference',
      {
        graphId: 'target' as GraphId,
        useGraphIdOrNameInput: true,
      },
      { id: 'ref' },
    );
    const callGraph = makeNode('callGraph', {}, { id: 'call' });
    const main = makeGraph(
      'main',
      'Main',
      [dynamicReference, callGraph],
      [makeConnection('ref', 'call', 'graph', 'graph')],
    );
    const target = makeGraph('target', 'Target', [makeNode('subGraph', { graphId: 'leaf' as GraphId })]);
    const leaf = makeGraph('leaf', 'Leaf');
    const spare = makeGraph('spare', 'Spare');

    const report = getGraphReachabilityReport(makeProject([main, target, leaf, spare], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), ['leaf', 'spare', 'target']);
    assert.deepEqual(sortGraphIds(report.unreachable), []);
  });

  test('does not count disabled Call Graph providers as reachable graph edges', () => {
    const reference = makeNode(
      'graphReference',
      {
        graphId: 'target' as GraphId,
        useGraphIdOrNameInput: false,
      },
      { id: 'ref', disabled: true },
    );
    const callGraph = makeNode('callGraph', {}, { id: 'call' });
    const main = makeGraph('main', 'Main', [reference, callGraph], [makeConnection('ref', 'call', 'graph', 'graph')]);
    const target = makeGraph('target', 'Target');

    const report = getGraphReachabilityReport(makeProject([main, target], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['target']);
  });

  test('matches runtime by using the first valid Call Graph input connection', () => {
    const staticReference = makeNode(
      'graphReference',
      {
        graphId: 'target' as GraphId,
        useGraphIdOrNameInput: false,
      },
      { id: 'static-ref' },
    );
    const dynamicReference = makeNode(
      'graphReference',
      {
        graphId: 'spare' as GraphId,
        useGraphIdOrNameInput: true,
      },
      { id: 'dynamic-ref' },
    );
    const callGraph = makeNode('callGraph', {}, { id: 'call' });
    const main = makeGraph(
      'main',
      'Main',
      [staticReference, dynamicReference, callGraph],
      [makeConnection('static-ref', 'call', 'graph', 'graph'), makeConnection('dynamic-ref', 'call', 'graph', 'graph')],
    );
    const target = makeGraph('target', 'Target');
    const spare = makeGraph('spare', 'Spare');

    const report = getGraphReachabilityReport(makeProject([main, target, spare], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main', 'target']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['spare']);
    assert.match(report.warnings.join('\n'), /runtime uses the first connection and ignores the rest/i);
  });

  test('ignores missing upstream Call Graph connections before resolving a later valid connection', () => {
    const reference = makeNode(
      'graphReference',
      {
        graphId: 'target' as GraphId,
        useGraphIdOrNameInput: false,
      },
      { id: 'ref' },
    );
    const callGraph = makeNode('callGraph', {}, { id: 'call' });
    const main = makeGraph(
      'main',
      'Main',
      [reference, callGraph],
      [makeConnection('missing-ref', 'call', 'graph', 'graph'), makeConnection('ref', 'call', 'graph', 'graph')],
    );
    const target = makeGraph('target', 'Target');

    const report = getGraphReachabilityReport(makeProject([main, target], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main', 'target']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.match(report.warnings.join('\n'), /wired from missing node missing-ref/i);
  });

  test('treats explicitly configured handlers of a connected manual delegate as definite', () => {
    const delegateManual = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: false,
        handlers: [{ key: 'weather', value: 'handler-a' as GraphId }],
        unknownHandler: 'handler-b' as GraphId,
      },
      { id: 'delegate' },
    );
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const main = makeGraph(
      'main',
      'Main',
      [llm, delegateManual],
      [makeConnection('llm', 'delegate', 'function-calls', 'function-call')],
    );
    const handlerA = makeGraph('handler-a', 'Weather Handler');
    const handlerB = makeGraph('handler-b', 'Unknown Handler');
    const named = makeGraph('named', 'Unrelated Graph');

    const report = getGraphReachabilityReport(makeProject([main, handlerA, handlerB, named], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['handler-a', 'handler-b', 'main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['named']);
  });

  test('does not treat handlers of a disconnected Delegate Tool Call as reachable', () => {
    const delegateManual = makeNode('delegateFunctionCall', {
      autoDelegate: false,
      handlers: [{ key: 'weather', value: 'handler' as GraphId }],
      unknownHandler: 'fallback' as GraphId,
    });
    const main = makeGraph('main', 'Main', [delegateManual]);
    const handler = makeGraph('handler', 'Weather Handler');
    const fallback = makeGraph('fallback', 'Fallback Handler');

    const report = getGraphReachabilityReport(makeProject([main, handler, fallback], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['fallback', 'handler']);
  });

  test('does not treat an inactive LLM Chat tool-call output as a Delegate Tool Call connection', () => {
    const llm = makeNode('llmChatV2', { useToolCalling: false }, { id: 'llm' });
    const delegateManual = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: false,
        handlers: [{ key: 'weather', value: 'handler' as GraphId }],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [llm, delegateManual],
      [makeConnection('llm', 'delegate', 'function-calls', 'function-call')],
    );
    const handler = makeGraph('handler', 'Weather Handler');

    const report = getGraphReachabilityReport(makeProject([main, handler], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['handler']);
  });

  test('uses only the first valid Delegate Tool Call input connection, like runtime execution', () => {
    const disabledLlm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'disabled-llm', disabled: true });
    const activeLlm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'active-llm' });
    const delegateManual = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: false,
        handlers: [{ key: 'weather', value: 'handler' as GraphId }],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [disabledLlm, activeLlm, delegateManual],
      [
        makeConnection('disabled-llm', 'delegate', 'function-calls', 'function-call'),
        makeConnection('active-llm', 'delegate', 'function-calls', 'function-call'),
      ],
    );
    const handler = makeGraph('handler', 'Weather Handler');

    const report = getGraphReachabilityReport(makeProject([main, handler], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['handler']);
  });

  test('recognizes legacy Chat function-call output when tool use is enabled', () => {
    const tool = makeNode('gptFunction', { name: 'weather' }, { id: 'tool' });
    const legacyChat = makeNode(
      'chat',
      { enableFunctionUse: true, parallelFunctionCalling: false },
      { id: 'legacy-chat' },
    );
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [tool, legacyChat, delegateAuto],
      [
        makeConnection('tool', 'legacy-chat', 'function', 'functions'),
        makeConnection('legacy-chat', 'delegate', 'function-call', 'function-call'),
      ],
    );
    const handler = makeGraph('handler', 'Tools/weather');

    const report = getGraphReachabilityReport(makeProject([main, handler], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['handler', 'main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
  });

  test('does not infer an auto-delegate target from a Tool whose name is supplied at runtime', () => {
    const tool = makeNode('gptFunction', { name: 'weather', useNameInput: true }, { id: 'tool' });
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [tool, llm, delegateAuto],
      [
        makeConnection('tool', 'llm', 'function', 'functions'),
        makeConnection('llm', 'delegate', 'function-calls', 'function-call'),
      ],
    );
    const handler = makeGraph('handler', 'Tools/weather');

    const report = getGraphReachabilityReport(makeProject([main, handler], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['handler']);
  });

  test('uses only the runtime-selected Tool connection into an LLM Chat Tools port', () => {
    const weatherTool = makeNode('gptFunction', { name: 'weather' }, { id: 'weather-tool' });
    const timeTool = makeNode('gptFunction', { name: 'time' }, { id: 'time-tool' });
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [weatherTool, timeTool, llm, delegateAuto],
      [
        makeConnection('weather-tool', 'llm', 'function', 'functions'),
        makeConnection('time-tool', 'llm', 'function', 'functions'),
        makeConnection('llm', 'delegate', 'function-calls', 'function-call'),
      ],
    );
    const weatherHandler = makeGraph('weather-handler', 'Tools/weather');
    const timeHandler = makeGraph('time-handler', 'Tools/time');

    const report = getGraphReachabilityReport(makeProject([main, weatherHandler, timeHandler], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main', 'weather-handler']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['time-handler']);
  });

  test('prefers an exact auto-delegate graph name before the contains fallback', () => {
    const tool = makeNode('gptFunction', { name: 'weather' }, { id: 'tool' });
    const tools = makeNode('array', {}, { id: 'tools' });
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [tool, tools, llm, delegateAuto],
      [
        makeConnection('tool', 'tools', 'function', 'input1'),
        makeConnection('tools', 'llm', 'output', 'functions'),
        makeConnection('llm', 'delegate', 'function-calls', 'function-call'),
      ],
    );
    const matchingName = makeGraph('matching-name', 'Tools/weather');
    const laterMatchingName = makeGraph('later-matching-name', 'Archive/weather');
    const exactName = makeGraph('exact-name', 'weather');
    const otherNamed = makeGraph('other-named', 'Other Named Graph');

    const report = getGraphReachabilityReport(
      makeProject([main, matchingName, laterMatchingName, exactName, otherNamed], 'main'),
    );

    assert.deepEqual(sortGraphIds(report.definite), ['exact-name', 'main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['later-matching-name', 'matching-name', 'other-named']);
  });

  test('uses active Tool-to-Delegate paths as reachability roots outside the Main Graph flow', () => {
    const main = makeGraph('main', 'Main');
    const tool = makeNode('gptFunction', { name: 'weather' }, { id: 'tool' });
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const dormantToolFlow = makeGraph(
      'dormant-tool-flow',
      'Dormant Tool Flow',
      [tool, llm, delegateAuto],
      [
        makeConnection('tool', 'llm', 'function', 'functions'),
        makeConnection('llm', 'delegate', 'function-calls', 'function-call'),
      ],
    );
    const matchingName = makeGraph('matching-name', 'Tools/weather');

    const report = getGraphReachabilityReport(makeProject([main, dormantToolFlow, matchingName], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main', 'matching-name']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['dormant-tool-flow']);
  });

  test('uses explicit manual Delegate Tool Call handlers as reachability roots outside the Main Graph flow', () => {
    const main = makeGraph('main', 'Main');
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateManual = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: false,
        handlers: [{ key: 'weather', value: 'handler' as GraphId }],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const dormantToolFlow = makeGraph(
      'dormant-tool-flow',
      'Dormant Tool Flow',
      [llm, delegateManual],
      [makeConnection('llm', 'delegate', 'function-calls', 'function-call')],
    );
    const handler = makeGraph('handler', 'Weather Handler');

    const report = getGraphReachabilityReport(makeProject([main, dormantToolFlow, handler], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['handler', 'main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['dormant-tool-flow']);
  });

  test('does not infer an auto-delegate target from a tool that is not connected to the delegate', () => {
    const tool = makeNode('gptFunction', { name: 'weather' }, { id: 'tool' });
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: undefined,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [tool, llm, delegateAuto],
      [makeConnection('llm', 'delegate', 'function-calls', 'function-call')],
    );
    const matchingName = makeGraph('matching-name', 'Tools/weather');

    const report = getGraphReachabilityReport(makeProject([main, matchingName], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['matching-name']);
  });

  test('marks an auto-delegate fallback only when a connected static tool has no matching graph', () => {
    const tool = makeNode('gptFunction', { name: 'time' }, { id: 'tool' });
    const llm = makeNode('llmChatV2', { useToolCalling: true }, { id: 'llm' });
    const delegateAuto = makeNode(
      'delegateFunctionCall',
      {
        autoDelegate: true,
        handlers: [],
        unknownHandler: 'fallback' as GraphId,
      },
      { id: 'delegate' },
    );
    const main = makeGraph(
      'main',
      'Main',
      [tool, llm, delegateAuto],
      [
        makeConnection('tool', 'llm', 'function', 'functions'),
        makeConnection('llm', 'delegate', 'function-calls', 'function-call'),
      ],
    );
    const fallback = makeGraph('fallback', 'Fallback Handler');

    const report = getGraphReachabilityReport(makeProject([main, fallback], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['fallback', 'main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
  });

  test('includes bundled Run Thread graph hooks as definite', () => {
    const runThread = makeNode('openaiRunThread', {
      toolCallHandlers: [{ key: 'search', value: 'tool' as GraphId }],
      onMessageCreationSubgraphId: 'message' as GraphId,
    });
    const main = makeGraph('main', 'Main', [runThread]);
    const tool = makeGraph('tool', 'Tool Handler');
    const message = makeGraph('message', 'Message Hook');

    const report = getGraphReachabilityReport(makeProject([main, tool, message], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main', 'message', 'tool']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
  });

  test('ignores cross-project aliases and disabled executors while reporting invalid references', () => {
    const disabledSubgraph = makeNode('subGraph', { graphId: 'child' as GraphId }, { disabled: true });
    const badCron = makeNode('cron', {
      targetGraph: 'missing' as GraphId,
      useTargetGraphInput: true,
    });
    const crossProject = makeNode('referencedGraphAlias', {
      projectId: 'external' as any,
      graphId: 'external-graph' as GraphId,
    });
    const main = makeGraph('main', 'Main', [disabledSubgraph, badCron, crossProject]);
    const child = makeGraph('child', 'Child');

    const report = getGraphReachabilityReport(makeProject([main, child], 'main'));

    assert.deepEqual(sortGraphIds(report.definite), ['main']);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['child']);
    assert.match(report.warnings.join('\n'), /references missing graph missing/);
  });

  test('warns when the project has no configured main graph', () => {
    const main = makeGraph('main', 'Main');
    const report = getGraphReachabilityReport(makeProject([main]));

    assert.deepEqual(sortGraphIds(report.definite), []);
    assert.deepEqual(sortGraphIds(report.dynamic), []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['main']);
    assert.equal(report.status, 'blocked');
    assert.equal(report.blockedReason, 'missing-main-graph');
    assert.deepEqual(report.unsupportedNodeTypes, []);
    assert.deepEqual(report.unsupportedReasons, []);
    assert.match(report.warnings[0] ?? '', /no main graph/i);
  });

  test('blocks when the configured main graph does not exist', () => {
    const main = makeGraph('main', 'Main');
    const report = getGraphReachabilityReport(makeProject([main], 'missing'));

    assert.equal(report.status, 'blocked');
    assert.equal(report.blockedReason, 'invalid-main-graph');
    assert.deepEqual(sortGraphIds(report.unreachable), ['main']);
    assert.match(report.warnings[0] ?? '', /does not exist/i);
  });

  test('marks reachable graphs containing unregistered node types as partial', () => {
    const child = makeGraph('child', 'Child', [makeNode('customPluginNode', {})]);
    const main = makeGraph('main', 'Main', [makeNode('subGraph', { graphId: 'child' as GraphId })]);
    const report = getGraphReachabilityReport(makeProject([main, child], 'main'), {
      registry: makeRegistry({
        registeredTypes: ['subGraph'],
      }),
    });

    assert.equal(report.status, 'partial');
    assert.deepEqual(report.unsupportedNodeTypes, ['customPluginNode']);
    assert.deepEqual(report.unsupportedReasons, ['unregistered-node-type']);
  });

  test('marks reachable graphs containing third-party plugin nodes as partial', () => {
    const child = makeGraph('child', 'Child', [makeNode('customPluginNode', {})]);
    const main = makeGraph('main', 'Main', [makeNode('subGraph', { graphId: 'child' as GraphId })]);
    const report = getGraphReachabilityReport(makeProject([main, child], 'main'), {
      registry: makeRegistry({
        registeredTypes: ['subGraph', 'customPluginNode'],
        pluginByType: { customPluginNode: 'custom-plugin' },
      }),
      builtInPluginIds: ['openai'],
    });

    assert.equal(report.status, 'partial');
    assert.deepEqual(report.unsupportedNodeTypes, ['customPluginNode']);
    assert.deepEqual(report.unsupportedReasons, ['third-party-plugin-node']);
  });

  test('treats reachable built-in plugin nodes as supported when the plugin id is configured as built-in', () => {
    const main = makeGraph('main', 'Main', [makeNode('openaiRunThread', {})]);
    const report = getGraphReachabilityReport(makeProject([main], 'main'), {
      registry: makeRegistry({
        registeredTypes: ['openaiRunThread'],
        pluginByType: { openaiRunThread: 'openai' },
      }),
      builtInPluginIds: ['openai'],
    });

    assert.equal(report.status, 'ready');
    assert.deepEqual(report.unsupportedNodeTypes, []);
    assert.deepEqual(report.unsupportedReasons, []);
  });

  test('normalizes built-in plugin spec ids to the registry plugin ids', () => {
    const main = makeGraph('main', 'Main', [makeNode('chatHuggingFace', {})]);
    const report = getGraphReachabilityReport(makeProject([main], 'main'), {
      registry: makeRegistry({
        registeredTypes: ['chatHuggingFace'],
        pluginByType: { chatHuggingFace: 'huggingface' },
      }),
      builtInPluginIds: resolveSupportedBuiltInPluginIds([
        {
          type: 'built-in',
          id: 'huggingFace',
          name: 'Hugging Face',
        },
      ]),
    });

    assert.equal(report.status, 'ready');
    assert.deepEqual(report.unsupportedNodeTypes, []);
    assert.deepEqual(report.unsupportedReasons, []);
  });

  test('ignores unsupported third-party plugin nodes in unreachable graphs', () => {
    const main = makeGraph('main', 'Main');
    const spare = makeGraph('spare', 'Spare', [makeNode('customPluginNode', {})]);
    const report = getGraphReachabilityReport(makeProject([main, spare], 'main'), {
      registry: makeRegistry({
        registeredTypes: ['customPluginNode'],
        pluginByType: { customPluginNode: 'custom-plugin' },
      }),
      builtInPluginIds: ['openai'],
    });

    assert.equal(report.status, 'ready');
    assert.deepEqual(report.unsupportedNodeTypes, []);
    assert.deepEqual(report.unsupportedReasons, []);
    assert.deepEqual(sortGraphIds(report.unreachable), ['spare']);
  });

  test('finds graphs that directly reference a target graph', () => {
    const target = makeGraph('target', 'Target', [makeNode('subGraph', { graphId: 'target' as GraphId })]);
    const directCaller = makeGraph('direct-caller', 'Direct Caller', [
      makeNode('subGraph', { graphId: 'target' as GraphId }),
    ]);
    const transitiveCaller = makeGraph('transitive-caller', 'Transitive Caller', [
      makeNode('subGraph', { graphId: 'direct-caller' as GraphId }),
    ]);
    const disabledCaller = makeGraph('disabled-caller', 'Disabled Caller', [
      makeNode('subGraph', { graphId: 'target' as GraphId }, { disabled: true }),
    ]);
    const project = makeProject([target, directCaller, transitiveCaller, disabledCaller], 'target');

    assert.deepEqual(sortGraphIds(getGraphIdsReferencingGraph(project, 'target' as GraphId)), ['direct-caller']);
  });

  test('finds web apps that directly reference a graph', () => {
    const buttonApp = makeUiGraph('button-app', [makeButton('button', 'target')]);
    const chatApp = makeUiGraph('chat-app', [makeChat('chat', 'target')]);
    const otherApp = makeUiGraph('other-app', [makeButton('button', 'other')]);
    const project = makeProject([makeGraph('target', 'Target')], 'target', {
      [buttonApp.id]: buttonApp,
      [chatApp.id]: chatApp,
      [otherApp.id]: otherApp,
    });

    assert.deepEqual([...getUiGraphIdsReferencingGraph(project, 'target' as GraphId)].sort(), [
      'button-app',
      'chat-app',
    ]);
  });

  test('finds static and dynamic Call Graph references to a target graph', () => {
    const staticReference = makeNode(
      'graphReference',
      {
        graphId: 'target' as GraphId,
        useGraphIdOrNameInput: false,
      },
      { id: 'static-ref' },
    );
    const staticCallGraph = makeNode('callGraph', {}, { id: 'static-call' });
    const staticCaller = makeGraph(
      'static-caller',
      'Static Caller',
      [staticReference, staticCallGraph],
      [makeConnection('static-ref', 'static-call', 'graph', 'graph')],
    );

    const dynamicReference = makeNode(
      'graphReference',
      {
        graphId: 'other' as GraphId,
        useGraphIdOrNameInput: true,
      },
      { id: 'dynamic-ref' },
    );
    const dynamicCallGraph = makeNode('callGraph', {}, { id: 'dynamic-call' });
    const dynamicCaller = makeGraph(
      'dynamic-caller',
      'Dynamic Caller',
      [dynamicReference, dynamicCallGraph],
      [makeConnection('dynamic-ref', 'dynamic-call', 'graph', 'graph')],
    );

    const target = makeGraph('target', 'Target');
    const other = makeGraph('other', 'Other');
    const project = makeProject([target, other, staticCaller, dynamicCaller], 'target');

    assert.deepEqual(sortGraphIds(getGraphIdsReferencingGraph(project, 'target' as GraphId)), [
      'dynamic-caller',
      'static-caller',
    ]);
  });

  test('does not mark Delegate Tool Call graphs as referencing every possible target graph', () => {
    const delegateAuto = makeNode('delegateFunctionCall', {
      autoDelegate: true,
      handlers: [],
      unknownHandler: undefined,
    });
    const delegateManual = makeNode('delegateFunctionCall', {
      autoDelegate: false,
      handlers: [{ key: 'tool', value: 'target' as GraphId }],
      unknownHandler: 'target' as GraphId,
    });
    const delegateCaller = makeGraph('delegate-caller', 'Delegate Caller', [delegateAuto, delegateManual]);
    const directCaller = makeGraph('direct-caller', 'Direct Caller', [
      makeNode('subGraph', { graphId: 'target' as GraphId }),
    ]);
    const target = makeGraph('target', 'Target');
    const project = makeProject([target, delegateCaller, directCaller], 'target');

    assert.deepEqual(sortGraphIds(getGraphIdsReferencingGraph(project, 'target' as GraphId)), ['direct-caller']);
  });
});
