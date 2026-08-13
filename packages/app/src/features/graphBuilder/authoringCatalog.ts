import {
  NODE_PREFAB_INSTANCE_TYPE,
  dataTypes,
  type ChartNode,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type NodeRegistration,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import deepEqual from 'fast-deep-equal';
import { cloneDeep } from 'lodash-es';
import { generatedBuiltInHelp } from '../../graphBuilderAssets.js';
import {
  assertGraphBuilderAuthoringValue,
  compareGraphBuilderStrings,
  GRAPH_BUILDER_LIMITS,
  GraphBuilderPortableJsonError,
  hashCanonicalGraphBuilderValue,
  parsePortableJson,
  type GraphBuilderAuthoringProject,
  type PortableJsonObject,
  type PortableJsonValue,
} from '../../domain/graphBuilder/index.js';
import { createAddedNode } from '../../domain/graphEditing/nodeActions.js';

export type GraphBuilderAuthoringChoiceFamily = 'registered' | 'referenced-graph-alias' | 'node-prefab';

export type GraphBuilderAuthoringCapabilities = Readonly<{
  createWithDefaults: boolean;
  inspectSafeProjection: boolean;
  resolvePorts: boolean;
  configureSettings: boolean;
  editLinkedPrefabInstance: boolean;
}>;

export type GraphBuilderSettingValueKind =
  | 'boolean'
  | 'number'
  | 'portable-json'
  | 'string'
  | 'string-array'
  | 'string-enum';

export type GraphBuilderSettingDescriptor = Readonly<{
  key: string;
  dataPath?: readonly string[];
  valueKind: GraphBuilderSettingValueKind;
  description: string;
  allowedValues?: readonly string[];
  projection?: 'default' | 'on-demand';
}>;

export type GraphBuilderSafeSettingOmission = Readonly<{
  key: string;
  reason: 'invalid' | 'oversized';
}>;

export type GraphBuilderSafeSettingsProjection = Readonly<{
  safeSettings: PortableJsonObject;
  omittedSettings: readonly GraphBuilderSafeSettingOmission[];
}>;

export type GraphBuilderNodeAuthoringAdapter = Readonly<{
  aliases?: readonly string[];
  description?: string;
  settings?: readonly GraphBuilderSettingDescriptor[];
  applySettings?: (input: {
    node: ChartNode;
    settings: PortableJsonObject;
    project: GraphBuilderAuthoringProject;
  }) => ChartNode;
  projectSafeSettings?: (input: { node: ChartNode; project: GraphBuilderAuthoringProject }) => PortableJsonObject;
}>;

export type GraphBuilderAuthoringCatalogEntry = Readonly<{
  authoringChoiceId: string;
  family: GraphBuilderAuthoringChoiceFamily;
  nodeType: string;
  displayName: string;
  description: string;
  aliases: readonly string[];
  capabilities: GraphBuilderAuthoringCapabilities;
  settings: readonly GraphBuilderSettingDescriptor[];
  safeDefaults?: PortableJsonObject;
  referencedProjectId?: string;
  referencedGraphId?: string;
  nodePrefabId?: string;
}>;

export type CreateGraphBuilderAuthoringCatalogOptions = {
  registry: NodeRegistration<any, any>;
  project: GraphBuilderAuthoringProject;
  referencedProjects: Record<ProjectId, Project>;
  safeSettingsAdapters?: Readonly<Record<string, GraphBuilderNodeAuthoringAdapter>>;
  authoringPreferences?: Readonly<{
    applyDefaultNodeColors: boolean;
  }>;
};

const SECRET_FIELD_NAMES = new Set(['token']);
const SECRET_FIELD_FRAGMENTS = [
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'bearertoken',
  'cookie',
  'credential',
  'headers',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
] as const;
const SETTING_VALUE_KINDS = new Set<GraphBuilderSettingValueKind>([
  'boolean',
  'number',
  'portable-json',
  'string',
  'string-array',
  'string-enum',
]);

const BUILT_IN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  array: 'Collects variadic inputs into an array.',
  boolean: 'Provides or converts a boolean value.',
  comment: 'Adds a non-executing Markdown note to the graph.',
  dataBus: 'Shares independent values through a compact topology rail without executing as a relay node.',
  expression: 'Evaluates a JavaScript expression with interpolation inputs.',
  externalCall: 'Calls a host-provided external function.',
  gptFunction: 'Declares a tool that an LLM Chat node can call.',
  graphInput: 'Declares one input at the graph boundary.',
  graphOutput: 'Declares one output at the graph boundary.',
  delegateFunctionCall: 'Delegates LLM tool calls to matching handler subgraphs or host external calls.',
  llmChatV2: 'Runs a provider-neutral LLM chat request with optional tool calling and continuation.',
  loopUntil: 'Runs another graph repeatedly until its configured stop condition is met.',
  number: 'Provides or converts a numeric value.',
  object: 'Builds an object from a JSON template and interpolation inputs.',
  passthrough: 'Passes variadic values through without changing them.',
  prompt: 'Builds one structured chat message.',
  randomNumber: 'Outputs a random number between configured minimum and maximum values.',
  subGraph: 'Runs another graph in the current project.',
  text: 'Builds text from a template and interpolation inputs.',
};

function ownRecordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || descriptor.get || descriptor.set) {
    throw new Error(`Graph Builder record entry "${key}" must be a data property.`);
  }
  return descriptor.value as T;
}

function getBuiltInDescription(nodeType: string): string {
  return (
    ownRecordValue(BUILT_IN_DESCRIPTIONS, nodeType) ??
    ownRecordValue(generatedBuiltInHelp.descriptions as Readonly<Record<string, string>>, nodeType) ??
    ''
  );
}

function setting(
  key: string,
  valueKind: GraphBuilderSettingValueKind,
  description: string,
  options: {
    allowedValues?: readonly string[];
    dataPath?: readonly string[];
    projection?: 'default' | 'on-demand';
  } = {},
): GraphBuilderSettingDescriptor {
  return Object.freeze({
    key,
    valueKind,
    description,
    ...(options.allowedValues ? { allowedValues: Object.freeze([...options.allowedValues]) } : {}),
    ...(options.dataPath ? { dataPath: Object.freeze([...options.dataPath]) } : {}),
    ...(options.projection ? { projection: options.projection } : {}),
  });
}

const STATIC_BUILT_IN_SETTINGS: Readonly<Record<string, readonly GraphBuilderSettingDescriptor[]>> = {
  array: [
    setting('flatten', 'boolean', 'Flatten array-valued inputs by one level.'),
    setting('flattenDeep', 'boolean', 'Recursively flatten nested arrays.'),
  ],
  boolean: [
    setting('value', 'boolean', 'The constant boolean value.'),
    setting('useValueInput', 'boolean', 'Read the value from an input port.'),
  ],
  comment: [setting('text', 'string', 'Markdown note text.', { projection: 'on-demand' })],
  codeNew: [
    setting('code', 'string', 'JavaScript source. Use {{name}} for dynamic inputs and return one value.', {
      projection: 'on-demand',
    }),
  ],
  expression: [
    setting('expression', 'string', 'JavaScript expression. Use {{name}} for dynamic inputs.', {
      projection: 'on-demand',
    }),
  ],
  externalCall: [
    setting('functionName', 'string', 'Host external-function name.'),
    setting('useFunctionNameInput', 'boolean', 'Read the function name from an input.'),
    setting('useErrorOutput', 'boolean', 'Expose an error output instead of failing immediately.'),
  ],
  gptFunction: [
    setting('name', 'string', 'Tool name exposed to the language model.'),
    setting('description', 'string', 'Tool description exposed to the language model.', {
      projection: 'on-demand',
    }),
    setting('schema', 'string', 'JSON Schema for the tool arguments.', { projection: 'on-demand' }),
    setting('strict', 'boolean', 'Request strict tool-argument validation.'),
    setting('resultHandling', 'string-enum', 'How the tool result is handled.', {
      allowedValues: ['continue', 'return-direct'],
    }),
    setting('useNameInput', 'boolean', 'Read the tool name from an input.'),
    setting('useDescriptionInput', 'boolean', 'Read the tool description from an input.'),
    setting('useSchemaInput', 'boolean', 'Read the argument schema from an input.'),
  ],
  graphInput: [
    setting('id', 'string', 'Stable graph input identifier.'),
    setting('dataType', 'string-enum', 'Graph input data type.', { allowedValues: dataTypes }),
    setting('defaultValue', 'portable-json', 'Optional portable default value.', { projection: 'on-demand' }),
    setting('useDefaultValueInput', 'boolean', 'Read the default value from an input port.'),
  ],
  graphOutput: [
    setting('id', 'string', 'Stable graph output identifier.'),
    setting('dataType', 'string-enum', 'Graph output data type.', { allowedValues: dataTypes }),
  ],
  number: [
    setting('value', 'number', 'The constant numeric value.'),
    setting('useValueInput', 'boolean', 'Read the value from an input port.'),
    setting('round', 'boolean', 'Round the output.'),
    setting('roundTo', 'number', 'Number of decimal places used for rounding.'),
  ],
  object: [
    setting('jsonTemplate', 'string', 'JSON template. Use {{name}} for dynamic inputs.', {
      projection: 'on-demand',
    }),
  ],
  dataBus: [],
  passthrough: [],
  prompt: [
    setting('type', 'string-enum', 'Chat message role.', {
      allowedValues: ['system', 'developer', 'user', 'assistant', 'function'],
    }),
    setting('promptText', 'string', 'Message template. Use {{name}} for dynamic inputs.', {
      projection: 'on-demand',
    }),
    setting('name', 'string', 'Optional message name or tool-call ID.'),
    setting('useTypeInput', 'boolean', 'Read the message role from an input.'),
    setting('useNameInput', 'boolean', 'Read the name from an input.'),
    setting('enableFunctionCall', 'boolean', 'Expose the function-call input.'),
    setting('computeTokenCount', 'boolean', 'Expose the token-count output.'),
    setting('isCacheBreakpoint', 'boolean', 'Mark this message as a provider cache breakpoint.'),
    setting('useIsCacheBreakpointInput', 'boolean', 'Read the cache-breakpoint flag from an input.'),
  ],
  text: [
    setting('text', 'string', 'Text template. Use {{name}} for dynamic inputs.', {
      projection: 'on-demand',
    }),
    setting('normalizeLineEndings', 'boolean', 'Normalize line endings to LF.'),
  ],
};

export function isGraphBuilderSecretFieldName(value: string): boolean {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SECRET_FIELD_NAMES.has(compact) ||
    compact.endsWith('token') ||
    SECRET_FIELD_FRAGMENTS.some((fragment) => compact.includes(fragment))
  );
}

function assertSafePath(path: readonly string[]): void {
  if (path.length === 0 || path.some((segment) => segment.length === 0 || isGraphBuilderSecretFieldName(segment))) {
    throw new Error(`Unsafe Graph Builder setting path: ${path.join('.') || '(empty)'}`);
  }
  if (path.some((segment) => segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
    throw new Error(`Dangerous Graph Builder setting path: ${path.join('.')}`);
  }
}

function redactSecretKeys(value: PortableJsonValue): PortableJsonValue {
  if (Array.isArray(value)) {
    return value.map(redactSecretKeys);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const output = Object.create(null) as PortableJsonObject;
  for (const [key, child] of Object.entries(value)) {
    if (!isGraphBuilderSecretFieldName(key)) {
      output[key] = redactSecretKeys(child);
    }
  }
  return output;
}

function containsSecretKey(value: PortableJsonValue): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSecretKey);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([key, child]) => isGraphBuilderSecretFieldName(key) || containsSecretKey(child));
}

function getPathValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setPathValue(target: Record<string, unknown>, path: readonly string[], value: PortableJsonValue): void {
  let current = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      current[segment] = cloneDeep(value);
      return;
    }
    const existing = current[segment];
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = Object.create(null);
    }
    current = current[segment] as Record<string, unknown>;
  });
}

function deletePathValue(target: Record<string, unknown>, path: readonly string[]): void {
  let current = target;
  for (let index = 0; index < path.length - 1; index++) {
    const next = current[path[index]!];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  delete current[path[path.length - 1]!];
}

function validateSettingValue(descriptor: GraphBuilderSettingDescriptor, value: PortableJsonValue): PortableJsonValue {
  switch (descriptor.valueKind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`Setting "${descriptor.key}" must be a boolean.`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new Error(`Setting "${descriptor.key}" must be a finite safe number.`);
      }
      return value;
    case 'string':
      if (typeof value !== 'string') {
        throw new Error(`Setting "${descriptor.key}" must be a string.`);
      }
      return value;
    case 'string-array':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error(`Setting "${descriptor.key}" must be an array of strings.`);
      }
      return value;
    case 'string-enum':
      if (typeof value !== 'string' || !descriptor.allowedValues?.includes(value)) {
        throw new Error(
          `Setting "${descriptor.key}" must be one of: ${descriptor.allowedValues?.join(', ') ?? '(none)'}.`,
        );
      }
      return value;
    case 'portable-json': {
      const portable = parsePortableJson(value);
      if (containsSecretKey(portable)) {
        throw new Error(`Setting "${descriptor.key}" contains a secret-like field name.`);
      }
      return portable;
    }
  }
}

function validateDescriptor(descriptor: GraphBuilderSettingDescriptor): void {
  if (
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    !Object.hasOwn(descriptor, 'key') ||
    !Object.hasOwn(descriptor, 'valueKind') ||
    !Object.hasOwn(descriptor, 'description')
  ) {
    throw new Error('Graph Builder setting descriptor is malformed.');
  }
  const projection = Object.hasOwn(descriptor, 'projection') ? descriptor.projection : undefined;
  const dataPath = Object.hasOwn(descriptor, 'dataPath') ? descriptor.dataPath : undefined;
  const allowedValues = Object.hasOwn(descriptor, 'allowedValues') ? descriptor.allowedValues : undefined;
  if (
    typeof descriptor.key !== 'string' ||
    descriptor.key.length === 0 ||
    descriptor.key.trim() !== descriptor.key ||
    typeof descriptor.description !== 'string' ||
    !SETTING_VALUE_KINDS.has(descriptor.valueKind) ||
    (projection !== undefined && projection !== 'default' && projection !== 'on-demand') ||
    (dataPath !== undefined &&
      (!Array.isArray(dataPath) || !dataPath.every((segment) => typeof segment === 'string'))) ||
    (allowedValues !== undefined &&
      (!Array.isArray(allowedValues) || !allowedValues.every((value) => typeof value === 'string')))
  ) {
    throw new Error('Graph Builder setting descriptor is malformed.');
  }
  if (isGraphBuilderSecretFieldName(descriptor.key)) {
    throw new Error(`Secret-like Graph Builder setting "${descriptor.key}" cannot be exposed.`);
  }
  const path = dataPath ?? [descriptor.key];
  assertSafePath(path);
  if (descriptor.valueKind === 'string-enum' && (!allowedValues || allowedValues.length === 0)) {
    throw new Error(`Enum setting "${descriptor.key}" has no allowed values.`);
  }
  if (
    allowedValues &&
    (descriptor.valueKind !== 'string-enum' || new Set(allowedValues).size !== allowedValues.length)
  ) {
    throw new Error(`Setting "${descriptor.key}" has invalid or duplicate enum values.`);
  }
}

function freezeSettingDescriptor(descriptor: GraphBuilderSettingDescriptor): GraphBuilderSettingDescriptor {
  const allowedValues = Object.hasOwn(descriptor, 'allowedValues') ? descriptor.allowedValues : undefined;
  const dataPath = Object.hasOwn(descriptor, 'dataPath') ? descriptor.dataPath : undefined;
  const projection = Object.hasOwn(descriptor, 'projection') ? descriptor.projection : undefined;
  return Object.freeze({
    key: descriptor.key,
    valueKind: descriptor.valueKind,
    description: descriptor.description,
    ...(allowedValues ? { allowedValues: Object.freeze([...allowedValues]) } : {}),
    ...(dataPath ? { dataPath: Object.freeze([...dataPath]) } : {}),
    ...(projection ? { projection } : {}),
  });
}

function ownAdapterProperty<K extends keyof GraphBuilderNodeAuthoringAdapter>(
  adapter: GraphBuilderNodeAuthoringAdapter | undefined,
  key: K,
): GraphBuilderNodeAuthoringAdapter[K] | undefined {
  if (adapter === undefined || !Object.hasOwn(adapter, key)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(adapter, key);
  if (!descriptor || descriptor.get || descriptor.set) {
    throw new Error(`Graph Builder authoring adapter property "${key}" must be a data property.`);
  }
  return descriptor.value as GraphBuilderNodeAuthoringAdapter[K];
}

function normalizeAdapter(adapter: GraphBuilderNodeAuthoringAdapter | undefined): GraphBuilderNodeAuthoringAdapter {
  if (adapter !== undefined && (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter))) {
    throw new Error('Graph Builder authoring adapter must be an object.');
  }
  const description = ownAdapterProperty(adapter, 'description');
  const aliases = ownAdapterProperty(adapter, 'aliases');
  const adapterSettings = ownAdapterProperty(adapter, 'settings');
  const applySettings = ownAdapterProperty(adapter, 'applySettings');
  const projectSafeSettings = ownAdapterProperty(adapter, 'projectSafeSettings');
  if (aliases !== undefined) {
    try {
      assertGraphBuilderAuthoringValue(aliases);
    } catch (cause) {
      throw new Error('Graph Builder authoring adapter contract is malformed.', { cause });
    }
  }
  if (adapterSettings !== undefined) {
    try {
      assertGraphBuilderAuthoringValue(adapterSettings);
    } catch (cause) {
      throw new Error('Graph Builder setting descriptor is malformed.', { cause });
    }
  }
  if (
    (description !== undefined && typeof description !== 'string') ||
    (aliases !== undefined &&
      (!Array.isArray(aliases) ||
        !aliases.every((alias) => typeof alias === 'string' && alias.length > 0 && alias.trim() === alias) ||
        new Set(aliases).size !== aliases.length)) ||
    (adapterSettings !== undefined && !Array.isArray(adapterSettings)) ||
    (applySettings !== undefined && typeof applySettings !== 'function') ||
    (projectSafeSettings !== undefined && typeof projectSafeSettings !== 'function')
  ) {
    throw new Error('Graph Builder authoring adapter contract is malformed.');
  }
  const settings = [...(adapterSettings ?? [])];
  const keys = new Set<string>();
  for (const descriptor of settings) {
    validateDescriptor(descriptor);
    if (keys.has(descriptor.key)) {
      throw new Error(`Duplicate Graph Builder setting descriptor "${descriptor.key}".`);
    }
    keys.add(descriptor.key);
  }
  return Object.freeze({
    ...(description === undefined ? {} : { description }),
    aliases: Object.freeze([...(aliases ?? [])]),
    settings: Object.freeze(settings.map(freezeSettingDescriptor)),
    ...(applySettings === undefined ? {} : { applySettings }),
    ...(projectSafeSettings === undefined ? {} : { projectSafeSettings }),
  });
}

function delegateConfigurationState(node: ChartNode): unknown[] {
  return [node.data, ...(node.variants ?? []).map((variant) => variant.data)];
}

function getDelegateFunctionCallConfigurationError(node: ChartNode): string | undefined {
  for (const [index, value] of delegateConfigurationState(node).entries()) {
    const location = index === 0 ? 'base settings' : `variant ${index} settings`;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `Delegate Tool Call ${location} must be an object.`;
    }
    const data = value as {
      autoDelegate?: unknown;
      fallBackToExternalCall?: unknown;
      passthroughErrors?: unknown;
    };
    if (data.autoDelegate !== true) {
      return `Delegate Tool Call ${location} must use Auto Delegate mode; manual handler maps remain outside the Graph Builder authoring surface.`;
    }
    if (data.fallBackToExternalCall !== undefined && typeof data.fallBackToExternalCall !== 'boolean') {
      return `Delegate Tool Call ${location} must use a boolean external-call fallback setting.`;
    }
    if (data.passthroughErrors !== undefined && typeof data.passthroughErrors !== 'boolean') {
      return `Delegate Tool Call ${location} must use a boolean passthrough-errors setting.`;
    }
    if (data.passthroughErrors === true && data.fallBackToExternalCall !== true) {
      return `Delegate Tool Call ${location} can pass through errors only when external-call fallback is enabled.`;
    }
  }
  return undefined;
}

function createBuiltInAdapter(
  nodeType: string,
  project: GraphBuilderAuthoringProject,
): GraphBuilderNodeAuthoringAdapter {
  if (nodeType === 'code') {
    return normalizeAdapter({
      description: getBuiltInDescription(nodeType),
      settings: [
        setting(
          'code',
          'string',
          'JavaScript source. Read typed values from inputs and return an object of typed named outputs.',
          { projection: 'on-demand' },
        ),
        setting('inputNames', 'string-array', 'Names of the legacy Code inputs.'),
        setting('outputNames', 'string-array', 'Names of the legacy Code outputs.'),
      ],
      projectSafeSettings: ({ node }) => {
        const data = node.data as Record<string, unknown>;
        const projection = Object.create(null) as PortableJsonObject;
        for (const key of ['code', 'inputNames', 'outputNames'] as const) {
          if (!Object.hasOwn(data, key) || data[key] === undefined) {
            continue;
          }
          const value = data[key];
          projection[key] = (key !== 'code' && typeof value === 'string' ? [value] : value) as PortableJsonValue;
        }
        return projection;
      },
    });
  }

  if (nodeType === 'delegateFunctionCall') {
    return normalizeAdapter({
      description: BUILT_IN_DESCRIPTIONS.delegateFunctionCall,
      settings: [
        setting(
          'autoDelegate',
          'boolean',
          'Automatically resolve tool names to existing handler subgraphs. Manual handler-map authoring is not supported in the first release.',
        ),
        setting(
          'fallBackToExternalCall',
          'boolean',
          'Try a host external call when no matching handler subgraph exists.',
        ),
        setting(
          'passthroughErrors',
          'boolean',
          'Return external-call failures as tool results instead of failing delegation.',
        ),
      ],
      applySettings: ({ node, settings }) => {
        const nextNode = cloneDeep(node);
        Object.assign(nextNode.data as Record<string, unknown>, settings);
        const configurationError = getDelegateFunctionCallConfigurationError(nextNode);
        if (configurationError) {
          throw new Error(configurationError);
        }
        return nextNode;
      },
    });
  }

  if (nodeType === 'llmChatV2') {
    return normalizeAdapter({
      description: BUILT_IN_DESCRIPTIONS.llmChatV2,
      settings: [
        setting('useToolCalling', 'boolean', 'Expose the Tools input and Tool Calls output.'),
        setting(
          'autoContinueToolCalls',
          'boolean',
          'Run declared tools and continue the LLM conversation until it produces a normal response.',
        ),
        setting('parallelToolCalls', 'boolean', 'Allow the provider to request multiple tools in one model round.'),
        setting('maxToolRounds', 'number', 'Maximum positive integer count of auto-continuation rounds.'),
      ],
      applySettings: ({ node, settings }) => {
        const nextNode = cloneDeep(node);
        Object.assign(nextNode.data as Record<string, unknown>, settings);
        const data = nextNode.data as {
          autoContinueToolCalls?: unknown;
          maxToolRounds?: unknown;
          parallelToolCalls?: unknown;
          useToolCalling?: unknown;
        };
        if (
          typeof data.maxToolRounds !== 'number' ||
          !Number.isSafeInteger(data.maxToolRounds) ||
          data.maxToolRounds < 1
        ) {
          throw new Error('LLM Chat maxToolRounds must be a positive safe integer.');
        }
        if (data.useToolCalling !== true && (data.autoContinueToolCalls === true || data.parallelToolCalls === true)) {
          throw new Error(
            'LLM Chat must enable tool calling before continuation or parallel tool calls can be enabled.',
          );
        }
        return nextNode;
      },
    });
  }

  if (nodeType === 'loopUntil') {
    return normalizeAdapter({
      description: BUILT_IN_DESCRIPTIONS.loopUntil,
      settings: [
        setting('targetGraph', 'string-enum', 'Existing project graph to execute on every iteration.', {
          allowedValues: Object.keys(project.graphs).sort(),
        }),
        setting('conditionType', 'string-enum', 'Condition that ends the loop.', {
          allowedValues: ['allOutputsSet', 'inputEqual'],
        }),
        setting(
          'maxIterations',
          'number',
          'Required positive safe-integer iteration limit for Graph Builder-authored loops.',
        ),
        setting('inputToCheck', 'string', 'Output name to compare when conditionType is inputEqual.'),
        setting('targetValue', 'string', 'String value that ends an inputEqual loop.'),
      ],
      applySettings: ({ node, settings, project: currentProject }) => {
        const nextNode = cloneDeep(node);
        Object.assign(nextNode.data as Record<string, unknown>, settings);
        const data = nextNode.data as {
          conditionType?: unknown;
          inputToCheck?: unknown;
          maxIterations?: unknown;
          targetGraph?: unknown;
        };
        if (
          typeof data.targetGraph !== 'string' ||
          !Object.hasOwn(currentProject.graphs, data.targetGraph as GraphId)
        ) {
          throw new Error('Loop Until targetGraph must identify an existing graph in the captured project.');
        }
        if (
          typeof data.maxIterations !== 'number' ||
          !Number.isSafeInteger(data.maxIterations) ||
          data.maxIterations < 1
        ) {
          throw new Error('Loop Until maxIterations must be a positive safe integer.');
        }
        if (
          data.conditionType === 'inputEqual' &&
          (typeof data.inputToCheck !== 'string' || data.inputToCheck.trim().length === 0)
        ) {
          throw new Error('Loop Until inputEqual requires a non-empty inputToCheck setting.');
        }
        return nextNode;
      },
    });
  }

  if (nodeType === 'subGraph') {
    return normalizeAdapter({
      description: BUILT_IN_DESCRIPTIONS.subGraph,
      settings: [
        setting('graphId', 'string-enum', 'Graph to execute.', {
          allowedValues: Object.keys(project.graphs).sort(),
        }),
        setting('useErrorOutput', 'boolean', 'Expose an error output.'),
        setting('useAsGraphPartialOutput', 'boolean', 'Forward partial outputs from the subgraph.'),
        setting('inputPortOrder', 'string-array', 'Optional input-port order.'),
        setting('outputPortOrder', 'string-array', 'Optional output-port order.'),
      ],
    });
  }

  return normalizeAdapter({
    description: getBuiltInDescription(nodeType),
    settings: ownRecordValue(STATIC_BUILT_IN_SETTINGS, nodeType) ?? [],
  });
}

function classifySettingProjectionError(error: unknown): GraphBuilderSafeSettingOmission['reason'] {
  return error instanceof GraphBuilderPortableJsonError && /\bexceeds\b/i.test(error.message) ? 'oversized' : 'invalid';
}

function projectSettings(
  node: ChartNode,
  project: GraphBuilderAuthoringProject,
  adapter: GraphBuilderNodeAuthoringAdapter,
  options: { includeOnDemand: boolean },
): GraphBuilderSafeSettingsProjection {
  const projected = adapter.projectSafeSettings?.({ node: cloneDeep(node), project: cloneDeep(project) });
  if (projected !== undefined) {
    assertGraphBuilderAuthoringValue(projected);
    if (projected === null || typeof projected !== 'object' || Array.isArray(projected)) {
      throw new Error('Safe projection adapter must return an object.');
    }
    const descriptorByKey = new Map((adapter.settings ?? []).map((descriptor) => [descriptor.key, descriptor]));
    for (const key of Object.keys(projected)) {
      if (!descriptorByKey.has(key)) {
        throw new Error(`Safe projection adapter returned undeclared setting "${key}".`);
      }
    }

    const output = Object.create(null) as PortableJsonObject;
    const omittedSettings: GraphBuilderSafeSettingOmission[] = [];
    for (const descriptor of adapter.settings ?? []) {
      if (
        (!options.includeOnDemand && descriptor.projection === 'on-demand') ||
        !Object.hasOwn(projected, descriptor.key)
      ) {
        continue;
      }
      try {
        output[descriptor.key] = validateSettingValue(
          descriptor,
          redactSecretKeys(parsePortableJson(projected[descriptor.key])),
        );
      } catch (error) {
        omittedSettings.push({ key: descriptor.key, reason: classifySettingProjectionError(error) });
      }
    }
    return { safeSettings: output, omittedSettings };
  }

  const output = Object.create(null) as PortableJsonObject;
  const omittedSettings: GraphBuilderSafeSettingOmission[] = [];
  for (const descriptor of adapter.settings ?? []) {
    if (!options.includeOnDemand && descriptor.projection === 'on-demand') {
      continue;
    }
    const path = descriptor.dataPath ?? [descriptor.key];
    const value = getPathValue(node.data, path);
    if (value !== undefined) {
      try {
        output[descriptor.key] = validateSettingValue(descriptor, redactSecretKeys(parsePortableJson(value)));
      } catch (error) {
        // Existing projects can contain legacy, malformed, or source-sized
        // values. Keep the adapter available while making every omitted field
        // and reason explicit to the caller.
        omittedSettings.push({ key: descriptor.key, reason: classifySettingProjectionError(error) });
      }
    }
  }
  return { safeSettings: output, omittedSettings };
}

function applySettings(
  node: ChartNode,
  project: GraphBuilderAuthoringProject,
  adapter: GraphBuilderNodeAuthoringAdapter,
  rawSettings: PortableJsonObject,
): ChartNode {
  const descriptors = new Map((adapter.settings ?? []).map((descriptor) => [descriptor.key, descriptor]));
  const settings = Object.create(null) as PortableJsonObject;

  for (const [key, value] of Object.entries(rawSettings)) {
    const descriptor = descriptors.get(key);
    if (!descriptor) {
      throw new Error(`Setting "${key}" is not supported for node type "${node.type}".`);
    }
    settings[key] = validateSettingValue(descriptor, value);
  }

  if (adapter.applySettings) {
    const result = adapter.applySettings({
      node: cloneDeep(node),
      settings,
      project: cloneDeep(project),
    });
    assertGraphBuilderAuthoringValue(result);
    if (
      !result ||
      result.id !== node.id ||
      result.type !== node.type ||
      !deepEqual({ ...result, data: undefined }, { ...node, data: undefined }) ||
      result.data === null ||
      typeof result.data !== 'object' ||
      Array.isArray(result.data)
    ) {
      throw new Error(`Settings adapter for "${node.type}" changed fields outside node.data.`);
    }

    const beforeData = cloneDeep(node.data) as Record<string, unknown>;
    const afterData = cloneDeep(result.data) as Record<string, unknown>;
    for (const key of Object.keys(settings)) {
      const descriptor = descriptors.get(key)!;
      const path = descriptor.dataPath ?? [key];
      deletePathValue(beforeData, path);
      deletePathValue(afterData, path);
      const resultValue = getPathValue(result.data, path);
      if (resultValue === undefined) {
        throw new Error(`Settings adapter for "${node.type}" did not assign "${key}".`);
      }
      validateSettingValue(descriptor, parsePortableJson(resultValue));
    }
    if (!deepEqual(beforeData, afterData)) {
      throw new Error(`Settings adapter for "${node.type}" changed undeclared node.data fields.`);
    }
    return result;
  }

  const nextNode = cloneDeep(node);
  if (nextNode.data === null || typeof nextNode.data !== 'object' || Array.isArray(nextNode.data)) {
    throw new Error(`Node type "${node.type}" does not have an object settings payload.`);
  }
  for (const [key, value] of Object.entries(settings)) {
    const descriptor = descriptors.get(key)!;
    setPathValue(nextNode.data as Record<string, unknown>, descriptor.dataPath ?? [key], value);
  }
  return nextNode;
}

function freezeCapabilities(capabilities: GraphBuilderAuthoringCapabilities): GraphBuilderAuthoringCapabilities {
  return Object.freeze({ ...capabilities });
}

function freezePortableValue<T extends PortableJsonValue>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => freezePortableValue(entry));
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((entry) => freezePortableValue(entry));
  }
  return Object.freeze(value);
}

function freezeEntry(entry: GraphBuilderAuthoringCatalogEntry): GraphBuilderAuthoringCatalogEntry {
  return Object.freeze({
    ...entry,
    aliases: Object.freeze([...entry.aliases]),
    capabilities: freezeCapabilities(entry.capabilities),
    settings: Object.freeze(entry.settings.map(freezeSettingDescriptor)),
    ...(entry.safeDefaults ? { safeDefaults: freezePortableValue(cloneDeep(entry.safeDefaults)) } : {}),
  });
}

export class GraphBuilderAuthoringCatalogSnapshot {
  readonly #registry: NodeRegistration<any, any>;
  readonly #referencedProjects: Record<ProjectId, Project>;
  readonly #entries: readonly GraphBuilderAuthoringCatalogEntry[];
  readonly #entriesByChoiceId: ReadonlyMap<string, GraphBuilderAuthoringCatalogEntry>;
  readonly #adaptersByChoiceId: ReadonlyMap<string, GraphBuilderNodeAuthoringAdapter>;
  readonly #adaptersByNodeType: ReadonlyMap<string, GraphBuilderNodeAuthoringAdapter>;
  readonly authoringPreferences: Readonly<{ applyDefaultNodeColors: boolean }>;
  readonly fingerprint: string;

  constructor(options: CreateGraphBuilderAuthoringCatalogOptions) {
    assertGraphBuilderAuthoringValue(options.project);
    assertGraphBuilderAuthoringValue(options.referencedProjects);
    this.#registry = options.registry;
    this.#referencedProjects = cloneDeep(options.referencedProjects);
    this.authoringPreferences = Object.freeze({
      applyDefaultNodeColors: options.authoringPreferences?.applyDefaultNodeColors ?? true,
    });
    const entries: GraphBuilderAuthoringCatalogEntry[] = [];
    const adaptersByChoiceId = new Map<string, GraphBuilderNodeAuthoringAdapter>();
    const adaptersByNodeType = new Map<string, GraphBuilderNodeAuthoringAdapter>();

    for (const nodeType of [...(options.registry.getNodeTypes() as string[])].sort()) {
      if (nodeType === 'referencedGraphAlias' || nodeType === NODE_PREFAB_INSTANCE_TYPE) {
        continue;
      }

      const plugin = options.registry.getPluginFor(nodeType);
      const explicitAdapter = options.safeSettingsAdapters
        ? ownRecordValue(options.safeSettingsAdapters, nodeType)
        : undefined;
      const adapter = explicitAdapter
        ? normalizeAdapter(explicitAdapter)
        : plugin
          ? normalizeAdapter(undefined)
          : createBuiltInAdapter(nodeType, options.project);
      const authoringChoiceId = `registered:${nodeType}`;
      let defaultNode: ChartNode;
      try {
        defaultNode = createAddedNode({
          nodeType,
          position: { x: 0, y: 0 },
          registry: options.registry,
          referencedProjects: this.#referencedProjects,
          project: options.project as Project,
          applyDefaultColor: this.authoringPreferences.applyDefaultNodeColors,
        });
      } catch {
        continue;
      }
      try {
        assertGraphBuilderAuthoringValue(defaultNode);
      } catch {
        continue;
      }

      const canUseRichAdapter = !plugin || explicitAdapter !== undefined;
      const safeDefaults =
        canUseRichAdapter && (adapter.settings?.length ?? 0) > 0
          ? projectSettings(defaultNode, options.project, adapter, { includeOnDemand: true }).safeSettings
          : undefined;

      entries.push(
        freezeEntry({
          authoringChoiceId,
          family: 'registered',
          nodeType,
          displayName: options.registry.getDynamicDisplayName(nodeType),
          description: adapter.description ?? '',
          aliases: adapter.aliases ?? [],
          capabilities: {
            createWithDefaults: true,
            inspectSafeProjection: canUseRichAdapter && (adapter.settings?.length ?? 0) > 0,
            resolvePorts: canUseRichAdapter,
            configureSettings: canUseRichAdapter && (adapter.settings?.length ?? 0) > 0,
            editLinkedPrefabInstance: false,
          },
          settings: adapter.settings ?? [],
          ...(safeDefaults && Object.keys(safeDefaults).length > 0 ? { safeDefaults } : {}),
        }),
      );
      adaptersByChoiceId.set(authoringChoiceId, adapter);
      if (canUseRichAdapter) {
        adaptersByNodeType.set(nodeType, adapter);
      }
    }

    for (const [projectId, referencedProject] of Object.entries(this.#referencedProjects).sort(([a], [b]) =>
      compareGraphBuilderStrings(a, b),
    )) {
      for (const [graphId, graph] of Object.entries(referencedProject.graphs).sort(([a], [b]) =>
        compareGraphBuilderStrings(a, b),
      )) {
        const authoringChoiceId = `referenced-graph-alias:${encodeURIComponent(projectId)}:${encodeURIComponent(graphId)}`;
        const adapter = normalizeAdapter({
          description: 'Runs a graph from a referenced Rivet project.',
          settings: [
            setting('useErrorOutput', 'boolean', 'Expose an error output.'),
            setting('outputCostDuration', 'boolean', 'Expose cost and duration outputs.'),
          ],
        });
        entries.push(
          freezeEntry({
            authoringChoiceId,
            family: 'referenced-graph-alias',
            nodeType: 'referencedGraphAlias',
            displayName: graph.metadata?.name ?? 'Unknown Graph',
            description: adapter.description ?? '',
            aliases: ['referenced graph', referencedProject.metadata.title],
            capabilities: {
              createWithDefaults: true,
              inspectSafeProjection: true,
              resolvePorts: true,
              configureSettings: true,
              editLinkedPrefabInstance: false,
            },
            settings: adapter.settings ?? [],
            referencedProjectId: projectId,
            referencedGraphId: graphId,
          }),
        );
        adaptersByChoiceId.set(authoringChoiceId, adapter);
        adaptersByNodeType.set('referencedGraphAlias', adapter);
      }
    }

    for (const [prefabId, prefab] of Object.entries(options.project.nodePrefabs ?? {}).sort(([a], [b]) =>
      compareGraphBuilderStrings(a, b),
    )) {
      const authoringChoiceId = `node-prefab:${encodeURIComponent(prefabId)}`;
      entries.push(
        freezeEntry({
          authoringChoiceId,
          family: 'node-prefab',
          nodeType: NODE_PREFAB_INSTANCE_TYPE,
          displayName: prefab.sourceNode.title || 'Untitled library node',
          description: 'Creates a linked, read-only instance of a project library node.',
          aliases: ['linked node', 'library node', prefab.sourceNode.type],
          capabilities: {
            createWithDefaults: true,
            inspectSafeProjection: true,
            resolvePorts: true,
            configureSettings: false,
            editLinkedPrefabInstance: false,
          },
          settings: [],
          nodePrefabId: prefabId,
        }),
      );
    }

    entries.sort((left, right) => compareGraphBuilderStrings(left.authoringChoiceId, right.authoringChoiceId));
    this.#entries = Object.freeze(entries);
    this.#entriesByChoiceId = new Map(entries.map((entry) => [entry.authoringChoiceId, entry]));
    this.#adaptersByChoiceId = adaptersByChoiceId;
    this.#adaptersByNodeType = adaptersByNodeType;
    this.fingerprint = hashCanonicalGraphBuilderValue({
      authoringPreferences: this.authoringPreferences,
      entries: entries.map(({ safeDefaults, ...entry }) => ({ ...entry, safeDefaults: safeDefaults ?? null })),
    });
  }

  listEntries(): readonly GraphBuilderAuthoringCatalogEntry[] {
    return this.#entries;
  }

  getEntry(authoringChoiceId: string): GraphBuilderAuthoringCatalogEntry | undefined {
    return this.#entriesByChoiceId.get(authoringChoiceId);
  }

  resolveAuthoringChoiceId(value: string): string | undefined {
    if (this.#entriesByChoiceId.has(value)) {
      return value;
    }

    const registeredChoiceId = `registered:${value}`;
    const registeredEntry = this.#entriesByChoiceId.get(registeredChoiceId);
    return registeredEntry?.family === 'registered' ? registeredChoiceId : undefined;
  }

  getNodeAuthoringChoiceId(node: ChartNode): string | undefined {
    let authoringChoiceId: string;
    try {
      if (node.type === NODE_PREFAB_INSTANCE_TYPE) {
        const prefabId = (node.data as { prefabId?: unknown } | undefined)?.prefabId;
        if (typeof prefabId !== 'string' || prefabId.length === 0) {
          return undefined;
        }
        authoringChoiceId = `node-prefab:${encodeURIComponent(prefabId)}`;
      } else if (node.type === 'referencedGraphAlias') {
        const data = node.data as { projectId?: unknown; graphId?: unknown } | undefined;
        if (
          typeof data?.projectId !== 'string' ||
          data.projectId.length === 0 ||
          typeof data.graphId !== 'string' ||
          data.graphId.length === 0
        ) {
          return undefined;
        }
        authoringChoiceId = `referenced-graph-alias:${encodeURIComponent(data.projectId)}:${encodeURIComponent(data.graphId)}`;
      } else {
        authoringChoiceId = `registered:${node.type}`;
      }
    } catch {
      return undefined;
    }

    return authoringChoiceId.length <= GRAPH_BUILDER_LIMITS.maxIdentifierLength &&
      this.#entriesByChoiceId.has(authoringChoiceId)
      ? authoringChoiceId
      : undefined;
  }

  getNodeTypeAdapter(nodeType: string): GraphBuilderNodeAuthoringAdapter | undefined {
    return this.#adaptersByNodeType.get(nodeType);
  }

  canResolveNodeType(nodeType: string): boolean {
    return this.#adaptersByNodeType.has(nodeType);
  }

  getDirectNodeMutationRejectionReason(baseNode: ChartNode | undefined, candidateNode: ChartNode): string | undefined {
    if (candidateNode.type === 'delegateFunctionCall') {
      const configurationChanged =
        !baseNode ||
        baseNode.type !== candidateNode.type ||
        !deepEqual(delegateConfigurationState(baseNode), delegateConfigurationState(candidateNode));
      return configurationChanged ? getDelegateFunctionCallConfigurationError(candidateNode) : undefined;
    }

    return undefined;
  }

  createNode(input: {
    authoringChoiceId: string;
    allocatedNodeId: NodeId;
    project: GraphBuilderAuthoringProject;
    settings?: PortableJsonObject;
  }): ChartNode {
    const entry = this.#entriesByChoiceId.get(input.authoringChoiceId);
    if (!entry || !entry.capabilities.createWithDefaults) {
      throw new Error(`Unknown or unsupported authoring choice "${input.authoringChoiceId}".`);
    }

    const nodeType =
      entry.family === 'referenced-graph-alias'
        ? `referencedGraphAlias:${entry.referencedProjectId}:${entry.referencedGraphId}`
        : entry.family === 'node-prefab'
          ? `${NODE_PREFAB_INSTANCE_TYPE}:${entry.nodePrefabId}`
          : entry.nodeType;
    let node = createAddedNode({
      nodeType,
      position: { x: 0, y: 0 },
      registry: this.#registry,
      referencedProjects: this.#referencedProjects,
      project: input.project as Project,
      appliedId: input.allocatedNodeId,
      applyDefaultColor: this.authoringPreferences.applyDefaultNodeColors,
    });
    assertGraphBuilderAuthoringValue(node);

    if (input.settings && Object.keys(input.settings).length > 0) {
      node = this.applyNodeSettings({
        authoringChoiceId: input.authoringChoiceId,
        node,
        project: input.project,
        settings: input.settings,
      });
    }
    return node;
  }

  applyNodeSettings(input: {
    authoringChoiceId?: string;
    node: ChartNode;
    project: GraphBuilderAuthoringProject;
    settings: PortableJsonObject;
  }): ChartNode {
    if (input.node.type === NODE_PREFAB_INSTANCE_TYPE) {
      throw new Error('Linked library nodes are read-only in Graph Builder Plan B.');
    }

    const adapter = input.authoringChoiceId
      ? this.#adaptersByChoiceId.get(input.authoringChoiceId)
      : this.#adaptersByNodeType.get(input.node.type);
    if (!adapter || (adapter.settings?.length ?? 0) === 0) {
      if (Object.keys(input.settings).length === 0) {
        return cloneDeep(input.node);
      }
      throw new Error(`Node type "${input.node.type}" has no safe settings adapter.`);
    }
    return applySettings(input.node, input.project, adapter, input.settings);
  }

  projectNodeSafeSettings(
    node: ChartNode,
    project: GraphBuilderAuthoringProject,
    options: { includeOnDemand?: boolean } = {},
  ): PortableJsonObject | undefined {
    const projection = this.projectNodeSafeSettingsDetailed(node, project, options);
    if (!projection) {
      return undefined;
    }
    return Object.keys(projection.safeSettings).length > 0 ? projection.safeSettings : undefined;
  }

  projectNodeSafeSettingsDetailed(
    node: ChartNode,
    project: GraphBuilderAuthoringProject,
    options: { includeOnDemand?: boolean } = {},
  ): GraphBuilderSafeSettingsProjection | undefined {
    if (node.type === NODE_PREFAB_INSTANCE_TYPE) {
      const prefabId = (node.data as { prefabId?: NodePrefabId } | undefined)?.prefabId;
      return prefabId
        ? {
            safeSettings: { prefabId } as unknown as PortableJsonObject,
            omittedSettings: [],
          }
        : undefined;
    }
    const adapter = this.#adaptersByNodeType.get(node.type);
    if (!adapter || (adapter.settings?.length ?? 0) === 0) {
      return undefined;
    }
    return projectSettings(node, project, adapter, {
      includeOnDemand: options.includeOnDemand ?? false,
    });
  }
}

export function createGraphBuilderAuthoringCatalog(
  options: CreateGraphBuilderAuthoringCatalogOptions,
): GraphBuilderAuthoringCatalogSnapshot {
  return new GraphBuilderAuthoringCatalogSnapshot(options);
}
