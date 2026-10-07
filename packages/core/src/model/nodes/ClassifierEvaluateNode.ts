import { nanoid } from 'nanoid/non-secure';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { NodeBodySpec } from '../NodeBodySpec.js';
import type {
  ChartNode,
  NodeConnection,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { formatNodeBodyMarkdownField, formatNodeBodyMarkdownSeparator } from '../nodeBodyMarkdown.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  createCaughtRunFailureOutputs,
  getRunFailureOutputDefinitions,
  shouldCatchRunFailure,
  withRunSuccessOutputs,
} from '../nodeRunFailure.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';
import {
  type ClassifierApiKeySource,
  type ClassifierCredentialNames,
  resolveClassifierApiKey,
} from '../classifier/credentials.js';
import { classifierArrayValues, classifierInputDataValue } from '../classifier/json.js';
import { normalizeClassifierState } from '../classifier/state.js';
import { CLASSIFIER_LIMITS, classifierPreparationCheck, ClassifierValueBudget } from '../classifier/limits.js';
import {
  calculateClassifierUsageCost,
  classifierProviders,
  DEFAULT_CLASSIFIER_RETRY_ON_NON_200_COOLDOWN_MS,
  DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES,
  getClassifierProvider,
  normalizeClassifierNon200RetryCooldownMs,
  normalizeClassifierNon200RetryCount,
} from '../classifier/providers.js';
import type { ClassifierQuestionDefinition } from '../classifier/types.js';

export type ClassifierEvaluateNodeData = {
  provider?: string;
  /** Empty or absent uses the selected provider's default model. */
  model?: string;
  useModelInput?: boolean;
  /** Adds the exact JSON body sent to the provider, excluding its auth header. */
  outputRequestBody?: boolean;
  /** Adds the complete parsed JSON body returned by the provider. */
  outputResponseBody?: boolean;
  /** Adds calculated provider cost details to the existing Usage output. */
  outputUsage?: boolean;
  retryOnNon200?: boolean;
  errorOnNon200?: boolean;
  catchRequestFailed?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
  timeoutMs?: number;
  apiKeySource?: ClassifierApiKeySource;
  apiKeyNamesByProvider?: Record<string, ClassifierCredentialNames | undefined>;
  /** @deprecated Migrated into apiKeyNamesByProvider. */
  apiKeyNames?: ClassifierCredentialNames;
};

export type ClassifierEvaluateNode = ChartNode<'classifierEvaluate', ClassifierEvaluateNodeData>;

export type ClassifierEvaluateBodySection = Readonly<{
  id: 'configuration' | 'error-behavior';
  fields: readonly Readonly<{ label: string; value: string }>[];
}>;

const QUESTION_TYPES = ['object', 'object[]', 'any', 'any[]'] as const;

export class ClassifierEvaluateNodeImpl extends NodeImpl<ClassifierEvaluateNode> {
  static create(): ClassifierEvaluateNode {
    return {
      type: 'classifierEvaluate',
      title: 'Classifier Evaluate',
      id: nanoid() as NodeId,
      visualData: { x: 0, y: 0, width: 260 },
      // Keep the default model in the provider descriptor rather than
      // serializing Jev's model into every new node. A future provider then
      // receives its own default when an author changes the Provider field.
      data: { provider: 'jev', timeoutMs: 30_000, errorOnNon200: true, catchRequestFailed: false },
    };
  }

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      {
        id: 'state' as PortId,
        title: 'State',
        dataType: [
          'string',
          'string[]',
          'image',
          'image[]',
          'chat-message',
          'chat-message[]',
          'object',
          'object[]',
          'any',
          'any[]',
        ],
        description:
          'Shared text, images, or assembled user messages for every question. Image bytes and base64 images are encoded automatically. JSON objects remain structured state.',
        required: false,
        splitRunBehavior: 'preserve-array',
      },
    ];
    if (this.data.useModelInput) {
      inputs.push({ id: 'model' as PortId, title: 'Model', dataType: 'string', required: true });
    }
    if (this.data.apiKeySource === 'input') {
      inputs.push({ id: 'apiKey' as PortId, title: 'API Key', dataType: 'string', required: true });
    }
    const count = getNextVariadicPortIndex(connections, this.chartNode.id, 'question', 'strict-positive');
    for (let index = 1; index <= count; index++) {
      inputs.push({
        id: `question${index}` as PortId,
        title: `Question ${index}`,
        dataType: QUESTION_TYPES,
        required: false,
        splitRunBehavior: 'preserve-array',
      });
    }
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [
      { id: 'answers' as PortId, title: 'Answers', dataType: 'object' },
      { id: 'usage' as PortId, title: 'Usage', dataType: 'object' },
      {
        id: 'cost' as PortId,
        title: 'Cost',
        dataType: 'number',
        description: 'Estimated USD cost for this successful evaluation. Excluded when pricing cannot be calculated.',
      },
    ];
    if (this.data.outputRequestBody === true) {
      outputs.push({ id: 'requestBody' as PortId, title: 'Classifier request body', dataType: 'object' });
    }
    if (this.data.outputResponseBody === true) {
      outputs.push({ id: 'responseBody' as PortId, title: 'Classifier response body', dataType: 'object' });
    }
    return [...outputs, ...getRunFailureOutputDefinitions(this.data)];
  }

  getEditors(): EditorDefinition<ClassifierEvaluateNode>[] {
    return [
      {
        type: 'group',
        label: 'Model',
        defaultOpen: true,
        editors: [
          {
            type: 'dropdown',
            label: 'Provider',
            dataKey: 'provider',
            defaultValue: 'jev',
            options: classifierProviders.map((provider) => ({ value: provider.id, label: provider.label })),
          },
          {
            type: 'string',
            label: 'Model',
            dataKey: 'model',
            useInputToggleDataKey: 'useModelInput',
            placeholder: getProviderForDisplay(this.data.provider).defaultModel,
          },
          {
            type: 'segmented',
            label: 'API key source',
            ariaLabel: 'API key source',
            dataKey: 'apiKeySource',
            defaultValue: 'configured',
            options: [
              { value: 'configured', label: 'Automatic' },
              { value: 'classifier-settings', label: 'Classifier settings' },
              { value: 'input', label: 'Input port' },
            ],
            helperMessage: getApiKeySourceHelperMessage,
          },
          {
            type: 'custom',
            label: 'Configured API key names',
            customEditorId: 'ClassifierCredentialNames',
            hideIf: (data) => data.apiKeySource === 'input' || data.apiKeySource === 'classifier-settings',
          },
        ],
      },
      {
        type: 'group',
        label: 'Outputs',
        editors: [
          {
            type: 'toggle',
            label: 'Output usage details',
            dataKey: 'outputUsage',
            helperMessage:
              'Adds estimated totalCost to Usage only for recognized requested/returned models. Unknown pricing is omitted. Provider-specific premiums are not included.',
          },
          {
            type: 'toggle',
            label: 'Output request body',
            dataKey: 'outputRequestBody',
            helperMessage:
              'Adds the exact classifier request JSON body sent to the provider. It excludes authorization headers and Rivet-managed API keys.',
          },
          {
            type: 'toggle',
            label: 'Output response body',
            dataKey: 'outputResponseBody',
            helperMessage:
              'Adds the complete classifier JSON response returned by the provider after validation. Rivet does not redact or truncate captured content.',
          },
        ],
      },
      {
        type: 'group',
        label: 'Advanced',
        editors: [
          {
            type: 'number',
            label: 'Overall timeout (seconds)',
            dataKey: 'timeoutMs',
            defaultValue: 30,
            storageMultiplier: 1000,
            min: 1,
            max: 600,
            step: 1,
          },
        ],
      },
      {
        type: 'group',
        label: 'Error behavior',
        editors: [
          {
            type: 'toggle',
            label: 'Fail on non-2XX status code',
            dataKey: 'errorOnNon200',
            defaultValue: true,
            helperMessage:
              'After retries, throw on a rejected HTTP request. When disabled, return Run failed and Run error; unavailable answer outputs are excluded.',
          },
          {
            type: 'toggle',
            label: 'Catch all failures',
            dataKey: 'catchRequestFailed',
            helperMessage:
              'Return any node execution failure through Run failed and Run error instead of stopping the graph. Explicit graph cancellation is never caught.',
          },
          {
            type: 'toggle',
            label: 'Retry on non-200',
            dataKey: 'retryOnNon200',
            helperMessage:
              'Retries non-authentication, non-validation provider HTTP responses. Provider rate-limit retries remain automatic.',
          },
          {
            type: 'number',
            label: 'Repeat times',
            dataKey: 'retryOnNon200RepeatTimes',
            defaultValue: DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES,
            min: 1,
            step: 1,
            layout: 'inline',
            helperMessage: 'Times to repeat after the initial request',
            hideIf: (data) => !data.retryOnNon200,
          },
          {
            type: 'number',
            label: 'Cooldown, ms',
            dataKey: 'retryOnNon200CooldownMs',
            defaultValue: DEFAULT_CLASSIFIER_RETRY_ON_NON_200_COOLDOWN_MS,
            min: 0,
            step: 1,
            layout: 'inline',
            helperMessage: 'Milliseconds to wait between repeats',
            hideIf: (data) => !data.retryOnNon200,
          },
        ],
      },
    ];
  }

  getBody(): NodeBodySpec {
    const sections = getClassifierEvaluateBodySections(this.data);
    return {
      type: 'markdown',
      disableLinks: true,
      text: sections
        .flatMap((section, index) => [
          ...(index === 0 ? [] : [formatNodeBodyMarkdownSeparator()]),
          ...section.fields.map((field) => formatNodeBodyMarkdownField(field.label, field.value)),
        ])
        .join(''),
    };
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Classifier Evaluate',
      infoBoxTitle: 'Classifier Evaluate',
      infoBoxBody:
        'Evaluates shared state and optional images against typed classifier questions. Images are shared evidence for every question.',
      group: ['Classifier'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    try {
      context.signal.throwIfAborted();
      const outputs = await this.processRun(inputs, context);
      context.signal.throwIfAborted();
      return withRunSuccessOutputs(this.data, outputs);
    } catch (error) {
      if (!shouldCatchRunFailure(this.data, error, context.signal)) throw error;
      return createCaughtRunFailureOutputs(this.getOutputDefinitions(), error);
    }
  }

  private async processRun(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const timeoutMs = normalizeTimeout(this.data.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const checkPreparation = classifierPreparationCheck(context.signal, deadline, timeoutMs);
    checkPreparation();
    const provider = getClassifierProvider(this.data.provider);
    if (!provider.browserExecutionSupported && context.executor === 'browser') {
      throw new Error(
        `${provider.label} cannot run in the Browser executor. Select the Node executor, or run through Studio Server or remote debugging.`,
      );
    }

    const apiKey = resolveClassifierApiKey({
      apiKeyNames: this.data.apiKeyNamesByProvider?.[provider.id] ?? this.data.apiKeyNames,
      apiKeySource: this.data.apiKeySource,
      context,
      defaults: provider.credentialNames,
      inputs,
      providerId: provider.id,
    });
    const graph = context.project?.graphs[context.execution?.graphId];
    if (
      classifierInputDataValue(inputs, 'images') !== undefined ||
      graph?.connections.some((connection) => connection.inputNodeId === this.id && connection.inputId === 'images')
    ) {
      throw new Error(
        'The separate Images input has been removed. Connect images or an assembled user message to State.',
      );
    }
    const stateInput = classifierInputDataValue(inputs, 'state');
    // First-party providers prepare the Rivet wrapper at their common boundary.
    // Existing custom descriptors still receive the legacy normalized State contract.
    const state = provider.evaluateInput
      ? { state: '', stateInput }
      : normalizeClassifierState(stateInput, checkPreparation, provider.maxRequestBytes);
    const legacyBudget = provider.evaluateInput
      ? undefined
      : new ClassifierValueBudget(checkPreparation, provider.maxRequestBytes);
    legacyBudget?.inspect(state);
    const modelValue = this.data.useModelInput
      ? classifierInputDataValue(inputs, 'model')?.value
      : getStaticModel(this.data.model, provider.defaultModel);
    if (typeof modelValue !== 'string' || modelValue.trim() === '') {
      throw new Error(`${provider.label} model is required.`);
    }
    legacyBudget?.inspect(modelValue);

    const questions: ClassifierQuestionDefinition[] = [];
    const flattenWork = { values: 0 };
    const questionInputs = Object.keys(inputs).filter((portId) => /^question\d+$/.test(portId));
    for (const port of questionInputs.sort(compareQuestionPorts)) {
      const input = classifierInputDataValue(inputs, port);
      if (input) {
        // Legacy descriptors do not own the shared preparation boundary.
        legacyBudget?.inspect(input.value);
        flattenQuestions(input.value, questions, checkPreparation, new Set(), 0, flattenWork);
      }
    }
    if (questions.length === 0) throw new Error('Classifier Evaluate requires at least one question.');

    const result = await (provider.evaluateInput ?? provider.evaluate).call(provider, {
      apiKey,
      model: modelValue,
      questions,
      retryOnNon200: this.data.retryOnNon200,
      retryOnNon200CooldownMs: this.data.retryOnNon200CooldownMs,
      retryOnNon200RepeatTimes: this.data.retryOnNon200RepeatTimes,
      signal: context.signal,
      ...state,
      timeoutMs,
      deadline,
    });
    // Custom providers still own their asynchronous transport, but no late
    // result may become a successful node output after the original deadline.
    checkPreparation();
    const totalCost = calculateClassifierUsageCost(provider, result.response.usage, {
      requestedModel: modelValue,
      responseModel: result.response.model,
    });
    // The provider's parsed response may also be exposed verbatim through the
    // diagnostic output. Do not mutate its Usage object while adding Rivet's
    // calculated accounting detail.
    const usage =
      !this.data.outputUsage || totalCost === undefined
        ? result.response.usage
        : { ...result.response.usage, totalCost };
    const outputs: Outputs = {
      ['answers' as PortId]: { type: 'object', value: result.response.answers },
      ['usage' as PortId]: { type: 'object', value: usage },
      ['cost' as PortId]:
        totalCost === undefined
          ? { type: 'control-flow-excluded', value: undefined }
          : { type: 'number', value: totalCost },
    };
    if (this.data.outputRequestBody === true) {
      checkPreparation();
      outputs['requestBody' as PortId] = { type: 'object', value: result.requestBody };
      checkPreparation();
    }
    if (this.data.outputResponseBody === true) {
      outputs['responseBody' as PortId] = { type: 'object', value: result.responseBody };
    }
    return outputs;
  }
}

function getProviderForDisplay(id: string | undefined) {
  try {
    return getClassifierProvider(id);
  } catch {
    return classifierProviders[0]!;
  }
}

function getStaticModel(model: string | undefined, defaultModel: string): string {
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : defaultModel;
}

/** Shared presentation model for the app's Classifier Evaluate card. */
export function getClassifierEvaluateBodySections(
  data: ClassifierEvaluateNodeData,
): readonly ClassifierEvaluateBodySection[] {
  const provider = getProviderForDisplay(data.provider);
  const sections: ClassifierEvaluateBodySection[] = [
    {
      id: 'configuration',
      fields: [
        { label: 'Provider', value: provider.label },
        { label: 'Model', value: data.useModelInput ? 'input' : getStaticModel(data.model, provider.defaultModel) },
      ],
    },
  ];
  if (data.errorOnNon200 !== false || data.catchRequestFailed || data.retryOnNon200) {
    sections.push({
      id: 'error-behavior',
      fields: [
        ...(data.errorOnNon200 !== false ? [{ label: 'Throw on non-2XX', value: 'Enabled' }] : []),
        ...(data.catchRequestFailed ? [{ label: 'Catch all failures', value: 'Enabled' }] : []),
        ...(data.retryOnNon200
          ? [
              { label: 'Retry on non-200', value: 'Enabled' },
              { label: 'Repeat times', value: `${normalizeClassifierNon200RetryCount(data.retryOnNon200RepeatTimes)}` },
              {
                label: 'Cooldown, ms',
                value: `${normalizeClassifierNon200RetryCooldownMs(data.retryOnNon200CooldownMs)}`,
              },
            ]
          : []),
      ],
    });
  }
  return sections;
}

function compareQuestionPorts(left: string, right: string): number {
  return Number(left.slice('question'.length)) - Number(right.slice('question'.length));
}

function getApiKeySourceHelperMessage(data: ClassifierEvaluateNodeData): string {
  if (data.apiKeySource === 'input') return 'Uses the API Key input port instead of a configured provider key.';
  const provider = getProviderForDisplay(data.provider);
  if (data.apiKeySource === 'classifier-settings')
    return `Uses only Settings > Classifier > ${provider.label} API Key on the executor. A missing key fails without fallback.`;
  return 'Automatic checks the named programmatic setting, then the named environment variable, then the saved Classifier key (default names only). OpenAI also accepts its legacy general key; Jev accepts its legacy plugin key last. Resolution happens on the executor, not in this editor.';
}

function flattenQuestions(
  value: unknown,
  target: ClassifierQuestionDefinition[],
  check: () => void,
  seen = new Set<object>(),
  depth = 0,
  work = { values: 0 },
): void {
  check();
  if (++work.values > CLASSIFIER_LIMITS.values) throw new Error('Question inputs have too many expanded values.');
  if (depth > CLASSIFIER_LIMITS.depth) throw new Error('Question inputs exceed the maximum nesting depth of 64.');
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Question inputs must not contain circular arrays.');
    seen.add(value);
    if (value.length > CLASSIFIER_LIMITS.questions)
      throw new Error('Classifier Evaluate supports at most 1000 questions.');
    for (const item of classifierArrayValues(value, 'Questions'))
      flattenQuestions(item, target, check, seen, depth + 1, work);
    seen.delete(value);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Question inputs must contain question definition objects or nested arrays of definitions.');
  }
  if (target.length >= CLASSIFIER_LIMITS.questions)
    throw new Error('Classifier Evaluate supports at most 1000 questions.');
  target.push(value as ClassifierQuestionDefinition);
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 600_000)
    : 30_000;
}

export const classifierEvaluateNode = nodeDefinition(ClassifierEvaluateNodeImpl, 'Classifier Evaluate');
