import {
  ClassifierEvaluateNodeImpl,
  LLMChatV2NodeImpl,
  ClassifierProfileNodeImpl,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  SubGraphNodeImpl,
  TextNodeImpl,
  ExtractObjectPathNodeImpl,
  StartBackgroundBranchNodeImpl,
  getGraphBoundary,
  loadProjectFromString,
  serializeProject,
  type ChartNode,
  type PortId,
  type Project,
  type GraphId,
  type UiGraphId,
  type UiComponentId,
} from '@valerypopoff/rivet2-node';
import * as storage from '../../routes/workflows/storage-backend.js';

const wire = (from: ChartNode, outputId: string, to: ChartNode, inputId: string) => ({
  outputNodeId: from.id,
  outputId: outputId as PortId,
  inputNodeId: to.id,
  inputId: inputId as PortId,
});

/** A -> background B -> C, with actual provider attempts in every project. */
export async function seedRunCostFixture(manualPricing = false) {
  const bundles = await storage.getExplicitBundleService();
  const bundle = await bundles.create(manualPricing ? 'Profile pricing fixture' : 'Cost accounting fixture', '');
  const items = await Promise.all(
    ['Cost root', 'Cost child', 'Cost grandchild'].map((name) =>
      storage.createWorkflowProjectItemWithBackend(bundle.relativePath, manualPricing ? `${name} priced` : name),
    ),
  );
  const projects: Project[] = [];
  for (const item of items)
    projects.push(loadProjectFromString((await storage.loadHostedProject(item.absolutePath)).contents));
  for (let index = 2; index >= 0; index--) {
    const project = projects[index]!;
    const graph = project.graphs[project.metadata.mainGraphId!]!;
    const request = GraphInputNodeImpl.create();
    request.data = { ...request.data, id: 'input', dataType: 'any' };
    const inputs = (['model', 'questions', 'state'] as const).map((id) => {
      if (index === 0) {
        const extract = ExtractObjectPathNodeImpl.create();
        extract.data.path = `$.${id}`;
        return extract;
      }
      const input = GraphInputNodeImpl.create();
      input.data = { ...input.data, id, dataType: 'any' };
      return input;
    });
    const [model, questions, state] = inputs as [ChartNode, ChartNode, ChartNode];
    const dataPort = index === 0 ? 'match' : 'data';
    const key = TextNodeImpl.create();
    key.data.text = 'local-cost-fixture-not-a-secret';
    const rootModel = TextNodeImpl.create();
    rootModel.data.text = 'jev-1.14.0';
    const evaluate = ClassifierEvaluateNodeImpl.create();
    evaluate.data = { ...evaluate.data, useModelInput: true, apiKeySource: 'input' };
    const output = GraphOutputNodeImpl.create();
    output.data = { ...output.data, id: 'output', dataType: 'object' };
    graph.nodes = [model, questions, state, key, evaluate, output, ...(index === 0 ? [request, rootModel] : [])];
    graph.connections = [
      wire(index === 0 ? rootModel : model, index === 0 ? 'output' : dataPort, evaluate, 'model'),
      wire(key, 'output', evaluate, 'apiKey'),
      wire(questions, dataPort, evaluate, 'question1'),
      wire(state, dataPort, evaluate, 'state'),
      wire(evaluate, 'answers', output, 'value'),
      ...(index === 0 ? inputs.map((input) => wire(request, 'data', input, 'object')) : []),
    ];
    if (manualPricing) {
      evaluate.data.tokenPricing = { inputPerMillionTokens: index + 2, outputPerMillionTokens: 0 };
    }
    // Exercise both price ownership paths inside one root-accounted bundle.
    if (manualPricing && index === 1) {
      const profile = ClassifierProfileNodeImpl.create();
      profile.data = {
        ...profile.data,
        useModelInput: true,
        apiKeySource: 'input',
        tokenPricing: { inputPerMillionTokens: index + 2, outputPerMillionTokens: 0 },
      };
      evaluate.data.configurationMode = 'profile';
      graph.nodes.push(profile);
      graph.connections = graph.connections.map((connection) =>
        connection.inputNodeId === evaluate.id && ['model', 'apiKey'].includes(connection.inputId)
          ? { ...connection, inputNodeId: profile.id }
          : connection,
      );
      graph.connections.push(wire(profile, 'profile', evaluate, 'classifierProfile'));
    }
    if (index === 0) {
      const llm = LLMChatV2NodeImpl.create();
      llm.data = {
        ...llm.data,
        provider: 'openrouter',
        model: 'test/model',
        apiKeySource: 'input',
        useAsGraphPartialOutput: true,
      };
      graph.nodes.push(llm);
      graph.connections = graph.connections.filter(
        (connection) => !(connection.inputNodeId === evaluate.id && connection.inputId === 'state'),
      );
      graph.connections.push(
        wire(key, 'output', llm, 'apiKey'),
        wire(key, 'output', llm, 'prompt'),
        wire(llm, 'response', evaluate, 'state'),
      );
      if (manualPricing) {
        llm.data.tokenPricing = { inputPerMillionTokens: 2, outputPerMillionTokens: 8 };
      }
    }
    if (index < 2) {
      const target = projects[index + 1]!;
      const call = SubGraphNodeImpl.create();
      call.data = {
        ...call.data,
        targetProjectId: target.metadata.id,
        targetVersion: 'latest',
        graphId: target.metadata.mainGraphId!,
        targetBoundary: getGraphBoundary(target, target.metadata.mainGraphId!),
      };
      graph.nodes.push(call);
      if (index === 0) {
        const trigger = StartBackgroundBranchNodeImpl.create();
        graph.nodes.push(trigger);
        graph.connections.push(
          wire(model, dataPort, trigger, 'input1'),
          wire(questions, dataPort, trigger, 'input2'),
          wire(evaluate, 'answers', trigger, 'input3'),
          wire(trigger, 'output1', call, 'model'),
          wire(trigger, 'output2', call, 'questions'),
          wire(trigger, 'output3', call, 'state'),
        );
      } else {
        graph.connections.push(
          wire(model, 'data', call, 'model'),
          wire(questions, 'data', call, 'questions'),
          wire(evaluate, 'answers', call, 'state'),
        );
      }
    }
    if (index === 0) {
      // The endpoint keeps early/background behavior; web-app actions use a
      // synchronous version so cancellation can interrupt a paid root call's successor.
      const blocking = structuredClone(graph);
      const trigger = blocking.nodes.find((node) => node.type === 'startBackgroundBranch')!;
      const outgoing = blocking.connections.filter((connection) => connection.outputNodeId === trigger.id);
      const incoming = blocking.connections.filter((connection) => connection.inputNodeId === trigger.id);
      blocking.nodes = blocking.nodes.filter((node) => node.id !== trigger.id);
      blocking.connections = blocking.connections.filter(
        (connection) => connection.inputNodeId !== trigger.id && connection.outputNodeId !== trigger.id,
      );
      for (const connection of outgoing) {
        const source = incoming.find((input) => input.inputId === connection.outputId.replace('output', 'input'))!;
        blocking.connections.push({ ...connection, outputNodeId: source.outputNodeId, outputId: source.outputId });
      }
      const graphId = 'web-cost-graph' as GraphId;
      blocking.metadata = { ...blocking.metadata, id: graphId, name: 'Web cost' };
      project.graphs[graphId] = blocking;
      const uiGraphId = 'cost-ui' as UiGraphId;
      project.uiGraphs = {
        [uiGraphId]: {
          id: uiGraphId,
          name: 'Cost app',
          components: [
            {
              id: 'cost-run' as UiComponentId,
              type: 'button',
              label: 'Run',
              action: {
                type: 'runGraph',
                graphId,
                inputs: { input: { type: 'state', key: 'request' } },
                outputKey: 'output',
                outputStateKey: 'result',
              },
            },
          ],
        },
      };
    }
    const item = items[index]!;
    const saved = await storage.loadHostedProject(item.absolutePath);
    await storage.saveHostedProject({
      projectPath: item.absolutePath,
      projectId: project.metadata.id,
      expectedRevisionId: saved.revisionId,
      contents: serializeProject(project) as string,
      datasetsContents: null,
    });
  }
  const item = items[0]!;
  const reviewed = await storage.listWorkflowProjectWebAppsWithBackend(item.relativePath);
  await storage.executeWorkflowPublicationCommandWithBackend({
    kind: 'publish-endpoint',
    relativePath: item.relativePath,
    endpointName: manualPricing ? 'profile-cost-acceptance' : 'cost-acceptance',
    preconditions: {
      expectedProjectId: reviewed.projectId,
      expectedPublicationVersion: reviewed.publicationVersion,
      expectedDraftRevisionId: reviewed.draftRevisionId,
    },
  });
  if (manualPricing) return { workflowId: projects[0]!.metadata.id, endpointName: 'profile-cost-acceptance' };
  const webReview = await storage.listWorkflowProjectWebAppsWithBackend(item.relativePath);
  await storage.executeWorkflowPublicationCommandWithBackend({
    kind: 'publish-web-apps',
    relativePath: item.relativePath,
    publications: [{ uiGraphId: 'cost-ui', slug: 'cost-app', allowedEmails: [] }],
    preconditions: {
      expectedProjectId: webReview.projectId,
      expectedPublicationVersion: webReview.publicationVersion,
      expectedDraftRevisionId: webReview.draftRevisionId,
    },
  });
  return { workflowId: projects[0]!.metadata.id, endpointName: 'cost-acceptance' };
}
