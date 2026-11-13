import {
  arrayNode,
  textNode,
  llmProfileNode,
  llmChatV2Node,
  graphOutputNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
} from '@valerypopoff/rivet2-node';

export const EXHAUSTION_PROVIDER_ORIGIN = 'https://recording-fixture.invalid';

/** No real credentials or provider requests: callers intercept the fixture origin. */
export function createExhaustedProfileGraph(graphId: GraphId, caught = false): NodeGraph {
  const profiles = [llmProfileNode.impl.create(), llmProfileNode.impl.create()];
  profiles.forEach((profile, index) => {
    profile.title = `Profile ${index + 1}`;
    Object.assign(profile.data, {
      provider: 'custom',
      model: 'fixture',
      customProviderApi: 'completions',
      customProviderBaseURL: `${EXHAUSTION_PROVIDER_ORIGIN}/v1`,
      apiKeySource: 'input',
      retryOnNon200: false,
    });
  });
  const credential = textNode.impl.create();
  credential.data.text = 'fixture-not-a-secret';
  const prompt = textNode.impl.create();
  prompt.data.text = 'Synthetic exhaustion probe';
  const chain = arrayNode.impl.create();
  const chat = llmChatV2Node.impl.create();
  Object.assign(chat.data, {
    configurationMode: 'profile',
    catchRequestFailed: caught,
    outputLLMAttempts: true,
    useAsGraphPartialOutput: false,
  });
  const output = graphOutputNode.impl.create();
  output.data.id = 'value';
  const wire = (
    from: { id: NodeConnection['outputNodeId'] },
    port: string,
    to: { id: NodeConnection['inputNodeId'] },
    input: string,
  ): NodeConnection =>
    ({ outputNodeId: from.id, outputId: port, inputNodeId: to.id, inputId: input }) as NodeConnection;
  return {
    metadata: { id: graphId, name: 'Exhausted profiles', description: '' },
    nodes: [...profiles, credential, prompt, chain, chat, output],
    connections: [
      ...profiles.flatMap((profile, index) => [
        wire(credential, 'output', profile, 'apiKey'),
        wire(profile, 'profile', chain, `input${index + 1}`),
      ]),
      wire(chain, 'output', chat, 'llmProfile'),
      wire(prompt, 'output', chat, 'prompt'),
      wire(chat, caught ? 'runFailed' : 'response', output, 'value'),
    ],
  };
}
