import {
  type ChatV2CallFinishedEvent,
  type DataValue,
  type GraphInputNode,
  type GraphOutputNode,
  type LLMChatV2Node,
  type LLMChatV2NodeData,
  type LooseDataValue,
  type NodeGraph,
  type GraphId,
  type NodeId,
  NodeRegistration,
  type Outputs,
  type PortId,
  type Project,
  type RuntimeSettings,
  coreCreateProcessor,
  deserializeProject,
  graphInputNode,
  graphOutputNode,
  llmChatV2Node,
  textNode,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import { z } from 'zod';
import { loadGraphBuilderPolicyProjectAsset } from '../../graphBuilderAssets.js';
import {
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
  canonicalGraphBuilderStringify,
  parseGraphBuilderTransactionalDecision,
  type GraphBuilderTransactionalDecision,
} from '../../domain/graphBuilder/index.js';
import type { ResolvedAiAssistModelSettings } from '../../utils/aiAssistModelSettings.js';
import type {
  GraphBuilderPolicyExecutionResult,
  GraphBuilderPolicyTurn,
  GraphBuilderPolicyUsage,
} from './sessionController.js';
import {
  GRAPH_BUILDER_POLICY_ALLOWED_NODE_TYPES,
  GRAPH_BUILDER_POLICY_ACTIVE_VARIANT,
  GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS,
  GRAPH_BUILDER_POLICY_MANIFEST,
  GRAPH_BUILDER_POLICY_VERSION,
  type GraphBuilderPolicyVariantManifest,
  type GraphBuilderPolicyVariantName,
} from './policyManifest.js';
import {
  GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS,
  GRAPH_BUILDER_POLICY_SEALED_EMPTY_LLM_DATA_KEYS,
  GRAPH_BUILDER_POLICY_SEALED_FALSE_LLM_DATA_KEYS,
} from './policyAssetContract.js';
import { GRAPH_BUILDER_POLICY_SYSTEM_PROMPT, normalizeGraphBuilderPolicyPrompt } from './policyPrompt.js';

export type {
  GraphBuilderPolicyExecutionResult,
  GraphBuilderPolicyTurn,
  GraphBuilderPolicyUsage,
} from './sessionController.js';
export { GRAPH_BUILDER_POLICY_VERSION } from './policyManifest.js';

type InjectableLlmDataKey = (typeof GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS)[number];

export type GraphBuilderPolicyAssistModel = Pick<
  ResolvedAiAssistModelSettings,
  'customProviderBaseURL' | 'displayName' | 'missingConfiguration' | 'model' | 'provider'
> &
  Partial<Pick<LLMChatV2NodeData, InjectableLlmDataKey>>;

export type GraphBuilderPolicyRunnerExecuteOptions = {
  assistModel: GraphBuilderPolicyAssistModel;
  runtimeSettings: Readonly<RuntimeSettings>;
  abortSignal: AbortSignal;
  onActivity?: () => void;
};

export interface GraphBuilderPolicyRunner {
  execute(
    turn: GraphBuilderPolicyTurn,
    options: GraphBuilderPolicyRunnerExecuteOptions,
  ): Promise<GraphBuilderPolicyExecutionResult>;
}

export type GraphBuilderPolicyRunnerErrorCode =
  | 'aborted'
  | 'accounting-invariant'
  | 'invalid-asset'
  | 'invalid-decision'
  | 'invalid-model-configuration'
  | 'invalid-turn'
  | 'policy-execution-failed';

export class GraphBuilderPolicyRunnerError extends Error {
  readonly code: GraphBuilderPolicyRunnerErrorCode;
  readonly usage?: GraphBuilderPolicyUsage;

  constructor(
    code: GraphBuilderPolicyRunnerErrorCode,
    message: string,
    options?: ErrorOptions,
    usage?: GraphBuilderPolicyUsage,
  ) {
    super(message, options);
    this.name = 'GraphBuilderPolicyRunnerError';
    this.code = code;
    this.usage = usage;
  }
}

type GraphBuilderPolicyProcessor = {
  run(): Promise<Outputs>;
};

export type GraphBuilderPolicyProcessorOptions = {
  graph: string;
  inputs: Record<string, LooseDataValue>;
  registry: NodeRegistration<any, any>;
  runtimeSettings: Readonly<RuntimeSettings>;
  abortSignal: AbortSignal;
  onActivity?: () => void;
  onChatV2CallFinished: (event: ChatV2CallFinishedEvent) => void;
};

export type GraphBuilderPolicyProcessorFactory = (
  project: Project,
  options: GraphBuilderPolicyProcessorOptions,
) => GraphBuilderPolicyProcessor;

export type GraphBuilderPolicyRunnerDependencies = {
  loadPolicyProject?: () => Promise<Project>;
  createProcessor?: GraphBuilderPolicyProcessorFactory;
};

const modelConfigurationSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'custom']),
  model: z.string().trim().min(1).max(512),
  customProviderBaseURL: z.string().max(4_096).optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  topP: z.number().finite().min(0).max(1).optional(),
  topK: z.number().finite().positive().optional(),
  presencePenalty: z.number().finite().min(-1).max(1).optional(),
  frequencyPenalty: z.number().finite().min(-1).max(1).optional(),
  stopSequences: z.array(z.string().max(1_024)).max(32).optional(),
  seed: z.number().int().safe().nonnegative().optional(),
  maxTokens: z.number().int().safe().positive().max(131_072).optional(),
  openAIReasoningEffort: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  openAIReasoningSummary: z.string().max(128).optional(),
  anthropicThinkingMode: z.enum(['', 'adaptive', 'enabled', 'disabled']).optional(),
  anthropicThinkingBudget: z.number().int().safe().nonnegative().optional(),
  anthropicEffort: z.enum(['', 'low', 'medium', 'high', 'max']).optional(),
  anthropicCacheControlTtl: z.enum(['', '5m', '1h']).optional(),
  googleThinkingBudget: z.number().int().safe().nonnegative().optional(),
  googleThinkingLevel: z.enum(['', 'minimal', 'low', 'medium', 'high']).optional(),
  googleIncludeThoughts: z.boolean().optional(),
});

const graphBuilderPolicyRegistry = new NodeRegistration()
  .register(graphInputNode)
  .register(textNode)
  .register(llmChatV2Node)
  .register(graphOutputNode);

const allowedNodeTypes = new Set<string>(GRAPH_BUILDER_POLICY_ALLOWED_NODE_TYPES);
const injectableLlmDataKeys = new Set<string>(GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS);
const forbiddenInjectedKeyPattern = /(api.?key|credential|secret|headers?)/i;
const utf8Encoder = new TextEncoder();
function policyError(
  code: GraphBuilderPolicyRunnerErrorCode,
  message: string,
  cause?: unknown,
  usage?: GraphBuilderPolicyUsage,
): GraphBuilderPolicyRunnerError {
  return new GraphBuilderPolicyRunnerError(code, message, cause === undefined ? undefined : { cause }, usage);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw policyError('aborted', 'Graph Builder policy execution was canceled.');
  }
}

function defaultProcessorFactory(
  project: Project,
  options: GraphBuilderPolicyProcessorOptions,
): GraphBuilderPolicyProcessor {
  const settings = options.runtimeSettings;
  return coreCreateProcessor(project, {
    openAiApiKey: settings.openAiApiKey,
    openAiKey: settings.openAiKey,
    anthropicApiKey: settings.anthropicApiKey,
    googleApiKey: settings.googleApiKey,
    customAiApiKey: settings.customAiApiKey,
    openAiOrganization: settings.openAiOrganization,
    openAiEndpoint: settings.openAiEndpoint,
    chatNodeTimeout: settings.chatNodeTimeout,
    throttleChatNode: settings.throttleChatNode,
    graph: options.graph,
    inputs: options.inputs,
    registry: options.registry,
    abortSignal: options.abortSignal,
    onPartialOutput: () => {
      options.onActivity?.();
    },
    onChatV2CallFinished: options.onChatV2CallFinished,
    // Keep the policy executor capability-minimal even if a caller passes a
    // RuntimeSettings object with extra host-owned properties.
    nativeApi: undefined,
    datasetProvider: undefined,
    audioProvider: undefined,
    mcpProvider: undefined,
    externalFunctions: undefined,
    onUserEvent: undefined,
    tokenizer: undefined,
    codeRunner: undefined,
    projectPath: undefined,
    projectReferenceLoader: undefined,
    editorExecutionCache: undefined,
    storedValueStore: undefined,
    knowledgeStores: undefined,
    getChatNodeEndpoint: undefined,
  });
}

async function defaultPolicyProjectLoader(): Promise<Project> {
  const policyAsset = await loadGraphBuilderPolicyProjectAsset();
  const [project] = deserializeProject(policyAsset);
  return project;
}

function getActiveVariant(): {
  name: typeof GRAPH_BUILDER_POLICY_ACTIVE_VARIANT;
  manifest: GraphBuilderPolicyVariantManifest;
} {
  // The authoritative decision contract contains arbitrary-key portable JSON
  // settings and optional fields. That contract cannot be represented
  // faithfully by the strict structured-output subsets used by the supported
  // providers. Keep provider formatting advisory and enforce the exact JSON
  // object plus the full runtime schema locally.
  const name = GRAPH_BUILDER_POLICY_ACTIVE_VARIANT;
  return { name, manifest: GRAPH_BUILDER_POLICY_MANIFEST.variants[name] };
}

function hasConnection(
  graph: NodeGraph,
  outputNodeId: string,
  outputId: string,
  inputNodeId: string,
  inputId: string,
): boolean {
  return graph.connections.some(
    (connection) =>
      connection.outputNodeId === outputNodeId &&
      connection.outputId === outputId &&
      connection.inputNodeId === inputNodeId &&
      connection.inputId === inputId,
  );
}

function assertPolicyGraph(
  graph: NodeGraph,
  name: GraphBuilderPolicyVariantName,
  variant: GraphBuilderPolicyVariantManifest,
): LLMChatV2Node {
  const expectedConnections = GRAPH_BUILDER_POLICY_EXPECTED_CONNECTIONS[name];
  const expectedNodeCount = new Set(
    expectedConnections.flatMap(([outputNodeId, _outputId, inputNodeId]) => [outputNodeId, inputNodeId]),
  ).size;
  if (graph.metadata?.id !== variant.graphId) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph identity does not match its manifest.`);
  }
  if (graph.nodes.length !== expectedNodeCount || graph.connections.length !== expectedConnections.length) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph topology is not the checked topology.`);
  }
  if (graph.nodes.some((node) => !allowedNodeTypes.has(node.type))) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph contains a disallowed node type.`);
  }
  if (
    graph.nodes.some(
      (node) =>
        node.disabled ||
        node.isConditional ||
        node.isSplitRun ||
        node.isSplitSequential ||
        node.splitRunConcurrency != null ||
        (node.variants?.length ?? 0) > 0,
    )
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph enables an unsealed execution mode.`);
  }

  const llmNode = graph.nodes.find((node) => node.id === variant.llmNodeId);
  const turnInput = graph.nodes.find((node) => node.id === variant.policyTurnInputNodeId);
  const decisionOutput = graph.nodes.find((node) => node.id === variant.decisionOutputNodeId);
  const systemPromptNodes = graph.nodes.filter((node) => node.type === 'text');
  const responseSchemaInput =
    variant.responseSchemaInputNodeId == null
      ? undefined
      : graph.nodes.find((node) => node.id === variant.responseSchemaInputNodeId);

  if (
    llmNode?.type !== 'llmChatV2' ||
    turnInput?.type !== 'graphInput' ||
    decisionOutput?.type !== 'graphOutput' ||
    systemPromptNodes.length !== 1
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph has incompatible designated nodes.`);
  }
  const typedLlmNode = llmNode as LLMChatV2Node;
  const typedTurnInput = turnInput as GraphInputNode;
  const typedDecisionOutput = decisionOutput as GraphOutputNode;
  const expectedDecisionOutputType = name === 'text' ? 'string' : 'any';
  if (
    typedTurnInput.data.id !== 'policyTurn' ||
    typedTurnInput.data.dataType !== 'string' ||
    typedTurnInput.data.useDefaultValueInput !== false ||
    typedTurnInput.data.defaultValue !== undefined ||
    typedDecisionOutput.data.id !== 'decision' ||
    typedDecisionOutput.data.dataType !== expectedDecisionOutputType
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph has incompatible graph ports.`);
  }
  if (
    (name === 'schema' &&
      (responseSchemaInput?.type !== 'graphInput' ||
        (responseSchemaInput.data as { id?: unknown }).id !== 'responseSchema' ||
        (responseSchemaInput.data as { dataType?: unknown }).dataType !== 'object' ||
        (responseSchemaInput.data as { useDefaultValueInput?: unknown }).useDefaultValueInput !== false ||
        (responseSchemaInput.data as { defaultValue?: unknown }).defaultValue !== undefined)) ||
    (name === 'text' && responseSchemaInput != null)
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph has an incompatible schema input.`);
  }

  const systemPromptNode = systemPromptNodes[0]!;
  const systemPromptData = systemPromptNode.data as { text?: unknown; normalizeLineEndings?: unknown };
  if (
    systemPromptData.normalizeLineEndings !== true ||
    normalizeGraphBuilderPolicyPrompt(String(systemPromptData.text ?? '')) !==
      normalizeGraphBuilderPolicyPrompt(GRAPH_BUILDER_POLICY_SYSTEM_PROMPT)
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} prompt does not match the checked prompt.`);
  }
  if (
    expectedConnections.some(
      ([outputNodeId, outputId, inputNodeId, inputId]) =>
        !hasConnection(graph, outputNodeId, outputId, inputNodeId, inputId),
    )
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} graph wiring is not the checked wiring.`);
  }

  const data = typedLlmNode.data;
  if (
    data.configurationMode !== 'inline' ||
    data.apiKeySource !== 'environment' ||
    data.responseFormat !== variant.responseFormat ||
    GRAPH_BUILDER_POLICY_SEALED_FALSE_LLM_DATA_KEYS.some((key) => Boolean(data[key])) ||
    GRAPH_BUILDER_POLICY_SEALED_EMPTY_LLM_DATA_KEYS.some((key) => data[key] !== '') ||
    !Array.isArray(data.headers) ||
    data.headers.length > 0 ||
    data.retryOnNon200RepeatTimes !== 0 ||
    data.retryOnNon200CooldownMs !== 0 ||
    data.maxToolRounds !== 1
  ) {
    throw policyError('invalid-asset', `Graph Builder policy ${name} LLM node violates its sealed runtime contract.`);
  }

  return typedLlmNode;
}

function assertAndClonePolicyProject(
  sourceProject: Project,
  name: GraphBuilderPolicyVariantName,
): { project: Project; llmNode: LLMChatV2Node } {
  const project = cloneDeep(sourceProject);
  if (
    project.metadata?.id !== GRAPH_BUILDER_POLICY_MANIFEST.projectId ||
    Object.keys(project.graphs).length !== 2 ||
    project.data != null ||
    project.nodePrefabs != null ||
    project.uiGraphs != null ||
    project.metadata?.knowledgeStores != null ||
    (project.plugins?.length ?? 0) !== 0 ||
    (project.references?.length ?? 0) !== 0
  ) {
    throw policyError('invalid-asset', 'Graph Builder policy project does not match its sealed manifest.');
  }

  let selectedLlmNode: LLMChatV2Node | undefined;
  for (const [variantName, variantManifest] of Object.entries(GRAPH_BUILDER_POLICY_MANIFEST.variants) as [
    GraphBuilderPolicyVariantName,
    GraphBuilderPolicyVariantManifest,
  ][]) {
    const graph = project.graphs[variantManifest.graphId as GraphId];
    if (graph == null) {
      throw policyError('invalid-asset', `Graph Builder policy project is missing its ${variantName} graph.`);
    }
    const llmNode = assertPolicyGraph(graph, variantName, variantManifest);
    if (variantName === name) {
      selectedLlmNode = llmNode;
    }
  }

  if (selectedLlmNode == null) {
    throw policyError('invalid-asset', `Graph Builder policy project is missing its selected ${name} graph.`);
  }
  return { project, llmNode: selectedLlmNode };
}

function sanitizeModelConfiguration(
  assistModel: GraphBuilderPolicyAssistModel,
): z.infer<typeof modelConfigurationSchema> {
  if (assistModel.missingConfiguration) {
    throw policyError('invalid-model-configuration', 'The selected AI Assist model is not fully configured.');
  }

  const candidate: Record<string, unknown> = {
    provider: assistModel.provider,
    model: assistModel.model,
    customProviderBaseURL: assistModel.customProviderBaseURL ?? '',
  };
  for (const key of GRAPH_BUILDER_POLICY_INJECTABLE_LLM_DATA_KEYS) {
    if (key === 'provider' || key === 'model' || key === 'customProviderBaseURL') {
      continue;
    }
    const value = assistModel[key];
    if (value !== undefined) {
      candidate[key] = value;
    }
  }

  const parsed = modelConfigurationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw policyError('invalid-model-configuration', 'The selected AI Assist model configuration is invalid.');
  }
  if (parsed.data.provider === 'custom') {
    let url: URL;
    try {
      url = new URL(parsed.data.customProviderBaseURL ?? '');
    } catch {
      throw policyError('invalid-model-configuration', 'The custom AI provider URL is invalid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw policyError('invalid-model-configuration', 'The custom AI provider URL must use HTTP or HTTPS.');
    }
  }

  return {
    ...parsed.data,
    customProviderBaseURL: parsed.data.provider === 'custom' ? parsed.data.customProviderBaseURL ?? '' : '',
  };
}

function injectModelConfiguration(
  llmNode: LLMChatV2Node,
  configuration: z.infer<typeof modelConfigurationSchema>,
): void {
  for (const key of Object.keys(configuration)) {
    if (!injectableLlmDataKeys.has(key) || forbiddenInjectedKeyPattern.test(key)) {
      throw policyError('invalid-asset', `Graph Builder policy rejected unsafe LLM configuration key "${key}".`);
    }
    (llmNode.data as Record<string, unknown>)[key] = configuration[key as keyof typeof configuration];
  }
}

function validateAndSerializeTurn(turn: GraphBuilderPolicyTurn): string {
  if (
    turn.protocolVersion !== GRAPH_BUILDER_PROTOCOL_VERSION ||
    turn.policyVersion !== GRAPH_BUILDER_POLICY_VERSION ||
    !turn.sessionId ||
    !turn.turnId ||
    !turn.attemptId
  ) {
    throw policyError('invalid-turn', 'Graph Builder policy turn correlation is invalid.');
  }

  let serialized: string;
  try {
    serialized = canonicalGraphBuilderStringify(turn);
  } catch (error) {
    throw policyError('invalid-turn', 'Graph Builder policy turn is not bounded portable JSON.', error);
  }
  if (utf8Encoder.encode(serialized).byteLength > GRAPH_BUILDER_LIMITS.maxPortableBytes) {
    throw policyError('invalid-turn', 'Graph Builder policy turn exceeds the request-size limit.');
  }
  return serialized;
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  let index = 0;
  let containerDepth = 0;

  const failInspection = (): never => {
    throw policyError('invalid-decision', 'Graph Builder policy response could not be inspected as exact JSON.');
  };
  const enterContainer = (): void => {
    containerDepth += 1;
    // The decision envelope adds a few fixed containers around portable node
    // settings. Stop well before recursive scanning could exhaust the stack;
    // the authoritative decision schema applies the tighter per-value limit.
    if (containerDepth > GRAPH_BUILDER_LIMITS.maxObjectDepth + 8) {
      throw policyError('invalid-decision', 'Graph Builder policy response exceeds the JSON nesting limit.');
    }
  };
  const leaveContainer = (): void => {
    containerDepth -= 1;
  };
  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index]!)) {
      index += 1;
    }
  };
  const readString = (): string => {
    if (text[index] !== '"') {
      return failInspection();
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      index += 1;
      if (character === '\\') {
        if (index >= text.length) {
          return failInspection();
        }
        index += 1;
      } else if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return failInspection();
        }
      }
    }
    return failInspection();
  };

  const scanValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === '{') {
      scanObject();
      return;
    }
    if (character === '[') {
      scanArray();
      return;
    }
    if (character === '"') {
      readString();
      return;
    }

    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index]!)) {
      index += 1;
    }
    if (start === index) {
      failInspection();
    }
  };
  const scanObject = (): void => {
    enterContainer();
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      leaveContainer();
      return;
    }

    const keys = new Set<string>();
    while (index < text.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) {
        throw policyError('invalid-decision', 'Graph Builder policy response contains duplicate JSON object keys.');
      }
      keys.add(key);

      skipWhitespace();
      if (text[index] !== ':') {
        failInspection();
      }
      index += 1;
      scanValue();
      skipWhitespace();
      if (text[index] === '}') {
        index += 1;
        leaveContainer();
        return;
      }
      if (text[index] !== ',') {
        failInspection();
      }
      index += 1;
    }
    failInspection();
  };
  const scanArray = (): void => {
    enterContainer();
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      leaveContainer();
      return;
    }

    while (index < text.length) {
      scanValue();
      skipWhitespace();
      if (text[index] === ']') {
        index += 1;
        leaveContainer();
        return;
      }
      if (text[index] !== ',') {
        failInspection();
      }
      index += 1;
    }
    failInspection();
  };

  scanValue();
  skipWhitespace();
  if (index !== text.length) {
    failInspection();
  }
}

export function parseExactGraphBuilderDecisionJson(value: string): GraphBuilderTransactionalDecision {
  const text = value.trim();
  if (
    text.length === 0 ||
    text[0] !== '{' ||
    text[text.length - 1] !== '}' ||
    utf8Encoder.encode(text).byteLength > GRAPH_BUILDER_LIMITS.maxPortableBytes
  ) {
    throw policyError('invalid-decision', 'Graph Builder policy response must be exactly one bounded JSON object.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw policyError('invalid-decision', 'Graph Builder policy response is not valid JSON.', error);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw policyError('invalid-decision', 'Graph Builder policy response must be one JSON object.');
  }
  assertNoDuplicateJsonObjectKeys(text);

  try {
    return parseGraphBuilderTransactionalDecision(parsed);
  } catch (error) {
    throw policyError('invalid-decision', 'Graph Builder policy response does not match the decision contract.', error);
  }
}

function parseDecisionOutput(value: DataValue | undefined): GraphBuilderTransactionalDecision {
  if (value == null || value.type === 'control-flow-excluded') {
    throw policyError('invalid-decision', 'Graph Builder policy did not return a decision.');
  }
  if (value.type !== 'string' || typeof value.value !== 'string') {
    throw policyError('invalid-decision', 'Graph Builder policy response must be an exact JSON text value.');
  }
  return parseExactGraphBuilderDecisionJson(value.value);
}

function usageFromEvent(event: ChatV2CallFinishedEvent): GraphBuilderPolicyUsage {
  const inputTokens = event.normalizedUsage?.promptTokens;
  const outputTokens = event.normalizedUsage?.completionTokens;
  const costUsd = event.pricing.costUsd;
  const presentCount = [inputTokens, outputTokens, costUsd].filter((value) => value != null).length;

  return {
    ...(inputTokens == null ? {} : { inputTokens }),
    ...(outputTokens == null ? {} : { outputTokens }),
    ...(costUsd == null ? {} : { costUsd }),
    completeness: presentCount === 0 ? 'unavailable' : presentCount === 3 ? 'complete' : 'partial',
  };
}

function validateObservedCall(
  observedCalls: readonly ChatV2CallFinishedEvent[],
  configuration: z.infer<typeof modelConfigurationSchema>,
  expectedOutcome?: ChatV2CallFinishedEvent['outcome'],
): ChatV2CallFinishedEvent | undefined {
  if (observedCalls.length === 0 && expectedOutcome == null) {
    return undefined;
  }
  if (
    observedCalls.length !== 1 ||
    observedCalls[0]!.attemptIndex !== 0 ||
    observedCalls[0]!.provider !== configuration.provider ||
    observedCalls[0]!.model !== configuration.model ||
    (expectedOutcome != null && observedCalls[0]!.outcome !== expectedOutcome)
  ) {
    throw policyError(
      'accounting-invariant',
      'Graph Builder policy call accounting did not match the designated policy attempt.',
    );
  }
  return observedCalls[0]!;
}

class DefaultGraphBuilderPolicyRunner implements GraphBuilderPolicyRunner {
  readonly #loadPolicyProject: () => Promise<Project>;
  readonly #createProcessor: GraphBuilderPolicyProcessorFactory;

  constructor(dependencies: GraphBuilderPolicyRunnerDependencies = {}) {
    this.#loadPolicyProject = dependencies.loadPolicyProject ?? defaultPolicyProjectLoader;
    this.#createProcessor = dependencies.createProcessor ?? defaultProcessorFactory;
  }

  async execute(
    turn: GraphBuilderPolicyTurn,
    options: GraphBuilderPolicyRunnerExecuteOptions,
  ): Promise<GraphBuilderPolicyExecutionResult> {
    throwIfAborted(options.abortSignal);
    const serializedTurn = validateAndSerializeTurn(turn);
    const configuration = sanitizeModelConfiguration(options.assistModel);
    const variant = getActiveVariant();

    let loadedProject: Project;
    try {
      loadedProject = await this.#loadPolicyProject();
    } catch (error) {
      throw policyError('invalid-asset', 'Graph Builder policy project could not be loaded.', error);
    }
    throwIfAborted(options.abortSignal);

    const { project, llmNode } = assertAndClonePolicyProject(loadedProject, variant.name);
    injectModelConfiguration(llmNode, configuration);

    const observedCalls: ChatV2CallFinishedEvent[] = [];
    const inputs: Record<string, LooseDataValue> = { policyTurn: serializedTurn };

    const processor = this.#createProcessor(project, {
      graph: variant.manifest.graphId,
      inputs,
      registry: graphBuilderPolicyRegistry,
      runtimeSettings: options.runtimeSettings,
      abortSignal: options.abortSignal,
      onActivity: options.onActivity,
      onChatV2CallFinished(event) {
        if (event.nodeId === (variant.manifest.llmNodeId as NodeId)) {
          observedCalls.push(event);
        }
      },
    });

    let outputs: Outputs;
    try {
      outputs = await processor.run();
    } catch (error) {
      const observedCall = validateObservedCall(observedCalls, configuration);
      const usage = observedCall == null ? undefined : usageFromEvent(observedCall);
      if (options.abortSignal.aborted) {
        throw policyError('aborted', 'Graph Builder policy execution was canceled.', error, usage);
      }
      throw policyError('policy-execution-failed', 'Graph Builder policy provider request failed.', error, usage);
    }
    if (options.abortSignal.aborted) {
      const observedCall = validateObservedCall(observedCalls, configuration);
      throw policyError(
        'aborted',
        'Graph Builder policy execution was canceled.',
        undefined,
        observedCall == null ? undefined : usageFromEvent(observedCall),
      );
    }

    const observedCall = validateObservedCall(observedCalls, configuration, 'success')!;
    const usage = usageFromEvent(observedCall);

    let decision: GraphBuilderTransactionalDecision;
    try {
      decision = parseDecisionOutput(outputs['decision' as PortId]);
    } catch (error) {
      if (error instanceof GraphBuilderPolicyRunnerError && error.code === 'invalid-decision') {
        throw policyError('invalid-decision', error.message, error, usage);
      }
      throw error;
    }
    return {
      protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
      policyVersion: GRAPH_BUILDER_POLICY_VERSION,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      attemptId: turn.attemptId,
      decision,
      usage,
    };
  }
}

export function createGraphBuilderPolicyRunner(
  dependencies: GraphBuilderPolicyRunnerDependencies = {},
): GraphBuilderPolicyRunner {
  return new DefaultGraphBuilderPolicyRunner(dependencies);
}
