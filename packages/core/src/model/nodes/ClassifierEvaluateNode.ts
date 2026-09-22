import { nanoid } from 'nanoid/non-secure';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { NodeBodySpec } from '../NodeBodySpec.js';
import type { ChartNode, NodeConnection, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { formatNodeBodyMarkdownField, formatNodeBodyMarkdownSeparator } from '../nodeBodyMarkdown.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { getNextVariadicPortIndex } from './variadicPortIndex.js';
import {
  type ClassifierApiKeySource,
  type ClassifierCredentialNames,
  resolveClassifierApiKey,
} from '../classifier/credentials.js';
import { assertClassifierEntry, assertClassifierInstructions } from '../classifier/questionHelpers.js';
import {
  calculateClassifierUsageCost,
  classifierProviders,
  DEFAULT_CLASSIFIER_RETRY_ON_NON_200_COOLDOWN_MS,
  DEFAULT_CLASSIFIER_RETRY_ON_NON_200_REPEAT_TIMES,
  getClassifierProvider,
  normalizeClassifierNon200RetryCooldownMs,
  normalizeClassifierNon200RetryCount,
} from '../classifier/providers.js';
import type {
  ClassifierChoiceQuestionDefinition,
  ClassifierNoulQuestionDefinition,
  ClassifierQuestionDefinition,
  ClassifierScoreQuestionDefinition,
} from '../classifier/types.js';

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
      data: { provider: 'jev', timeoutMs: 30_000 },
    };
  }

  getInputDefinitions(connections: NodeConnection[]): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      {
        id: 'state' as PortId,
        title: 'State',
        dataType: ['string', 'object', 'object[]', 'any', 'any[]'],
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
    ];
    if (this.data.outputRequestBody === true) {
      outputs.push({ id: 'requestBody' as PortId, title: 'Classifier request body', dataType: 'object' });
    }
    if (this.data.outputResponseBody === true) {
      outputs.push({ id: 'responseBody' as PortId, title: 'Classifier response body', dataType: 'object' });
    }
    return outputs;
  }

  getEditors(): EditorDefinition<ClassifierEvaluateNode>[] {
    return [
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
        placeholder: 'jev-latest',
      },
      {
        type: 'segmented',
        label: 'API key source',
        ariaLabel: 'API key source',
        dataKey: 'apiKeySource',
        defaultValue: 'configured',
        options: [
          { value: 'configured', label: 'Configured key' },
          { value: 'input', label: 'Input port' },
        ],
        helperMessage: getApiKeySourceHelperMessage,
      },
      {
        type: 'custom',
        label: 'Configured API key names',
        customEditorId: 'ClassifierCredentialNames',
        hideIf: (data) => data.apiKeySource === 'input',
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
              'Adds totalCost to Usage when the selected provider has fixed token pricing. Jev input tokens cost $0.042 / MTok; output tokens are free.',
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
            label: 'Retry on non-200',
            dataKey: 'retryOnNon200',
            helperMessage:
              'Retries non-authentication, non-validation provider HTTP responses. Jev rate-limit retries remain automatic.',
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
      infoBoxBody: 'Evaluates one shared state against a batch of independent typed classifier questions in one request.',
      group: ['Classifier'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
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
    const stateInput = inputs['state' as PortId];
    const state = stateInput === undefined ? '' : stateInput.value;
    assertClassifierState(state);
    const modelValue = this.data.useModelInput
      ? inputs['model' as PortId]?.value
      : getStaticModel(this.data.model, provider.defaultModel);
    if (typeof modelValue !== 'string' || modelValue.trim() === '') {
      throw new Error(`${provider.label} model is required.`);
    }

    const questions: ClassifierQuestionDefinition[] = [];
    const questionInputs = Object.entries(inputs).filter(([portId]) => /^question\d+$/.test(portId));
    for (const [, input] of questionInputs.sort(compareQuestionPorts)) {
      if (input) flattenQuestions(input.value, questions);
    }
    if (questions.length === 0) throw new Error('Classifier Evaluate requires at least one question.');

    const ids = new Set<string>();
    for (const question of questions) {
      validateQuestion(question);
      if (ids.has(question.questionId)) {
        throw new Error(`Question ID '${question.questionId}' is duplicated in this evaluation.`);
      }
      ids.add(question.questionId);
    }

    const result = await provider.evaluate({
      apiKey,
      model: modelValue,
      questions,
      retryOnNon200: this.data.retryOnNon200,
      retryOnNon200CooldownMs: this.data.retryOnNon200CooldownMs,
      retryOnNon200RepeatTimes: this.data.retryOnNon200RepeatTimes,
      signal: context.signal,
      state,
      timeoutMs: normalizeTimeout(this.data.timeoutMs),
    });
    const totalCost = this.data.outputUsage ? calculateClassifierUsageCost(provider, result.response.usage) : undefined;
    // The provider's parsed response may also be exposed verbatim through the
    // diagnostic output. Do not mutate its Usage object while adding Rivet's
    // calculated accounting detail.
    const usage = totalCost === undefined ? result.response.usage : { ...result.response.usage, totalCost };
    const outputs: Outputs = {
      ['answers' as PortId]: { type: 'object', value: result.response.answers },
      ['usage' as PortId]: { type: 'object', value: usage },
    };
    if (this.data.outputRequestBody === true) {
      outputs['requestBody' as PortId] = { type: 'object', value: result.requestBody };
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
  if (data.retryOnNon200) {
    sections.push({
      id: 'error-behavior',
      fields: [
        { label: 'Retry on non-200', value: 'Enabled' },
        { label: 'Repeat times', value: `${normalizeClassifierNon200RetryCount(data.retryOnNon200RepeatTimes)}` },
        { label: 'Cooldown, ms', value: `${normalizeClassifierNon200RetryCooldownMs(data.retryOnNon200CooldownMs)}` },
      ],
    });
  }
  return sections;
}

function compareQuestionPorts([left]: [string, unknown], [right]: [string, unknown]): number {
  return Number(left.slice('question'.length)) - Number(right.slice('question'.length));
}

function getApiKeySourceHelperMessage(data: ClassifierEvaluateNodeData): string {
  if (data.apiKeySource === 'input') return 'Uses the API Key input port instead of a configured provider key.';
  const provider = getProviderForDisplay(data.provider);
  return data.apiKeyNamesByProvider?.[provider.id] == null && data.apiKeyNames == null
    ? `Configured key checks ${provider.credentialNames.programmaticName} or ${provider.credentialNames.environmentVariableName}, including Settings > Classifier > ${provider.label} API Key.`
    : 'Configured key checks the named programmatic setting first, then the named environment variable.';
}

function flattenQuestions(value: unknown, target: ClassifierQuestionDefinition[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenQuestions(item, target);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('Question inputs must contain question definition objects or nested arrays of definitions.');
  }
  target.push(value as ClassifierQuestionDefinition);
}

function validateQuestion(question: ClassifierQuestionDefinition): void {
  if (typeof question.questionId !== 'string' || question.questionId.trim() === '') {
    throw new Error('Every classifier question must have a non-empty Question ID.');
  }
  if (!['choice', 'score', 'noul'].includes(question.type)) {
    throw new Error(`Question '${question.questionId}' has an unsupported type.`);
  }
  assertClassifierInstructions(question.instructions, `Question '${question.questionId}' instructions`);
  if (question.type === 'choice') {
    const criteria = (question as ClassifierChoiceQuestionDefinition).criteria;
    if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
      throw new Error(`Choice question '${question.questionId}' requires object criteria.`);
    }
    const keys = Object.keys(criteria);
    if (keys.length < 2 || keys.length > 255) {
      throw new Error(`Choice question '${question.questionId}' requires 2 to 255 options.`);
    }
    for (const key of keys) assertClassifierEntry(criteria[key], `Question '${question.questionId}' criteria.${key}`);
  } else if (question.type === 'score') {
    const criteria = (question as ClassifierScoreQuestionDefinition).criteria;
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
      throw new Error(`Score question '${question.questionId}' requires 2 to 10 levels.`);
    }
    criteria.forEach((entry, index) => assertClassifierEntry(entry, `Question '${question.questionId}' criteria[${index}]`));
  } else {
    const criteria = (question as ClassifierNoulQuestionDefinition).criteria;
    if (criteria !== undefined) {
      if (
        typeof criteria !== 'object' ||
        criteria === null ||
        Array.isArray(criteria) ||
        !Object.prototype.hasOwnProperty.call(criteria, 'true') ||
        !Object.prototype.hasOwnProperty.call(criteria, 'false')
      ) {
        throw new Error(`Noul question '${question.questionId}' criteria must contain true and false entries.`);
      }
      assertClassifierEntry(criteria.true, `Question '${question.questionId}' criteria.true`);
      assertClassifierEntry(criteria.false, `Question '${question.questionId}' criteria.false`);
    }
  }
}

function assertClassifierState(value: unknown): asserts value is string | Record<string, unknown> | unknown[] {
  if (typeof value === 'string') return;
  if (typeof value !== 'object' || value === null) throw new Error('State must be a string, JSON object, or JSON array.');
  assertJsonCompatible(value, 'State', new Set());
}

function assertJsonCompatible(value: unknown, label: string, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${label} is not JSON-compatible.`);
  if (seen.has(value)) throw new Error(`${label} contains a circular reference.`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonCompatible(item, `${label}[${index}]`, seen));
  else for (const [key, item] of Object.entries(value)) assertJsonCompatible(item, `${label}.${key}`, seen);
  seen.delete(value);
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 600_000)
    : 30_000;
}

export const classifierEvaluateNode = nodeDefinition(ClassifierEvaluateNodeImpl, 'Classifier Evaluate');
