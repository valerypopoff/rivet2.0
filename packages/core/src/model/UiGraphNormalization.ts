import type { Project } from './Project.js';
import {
  UI_GRAPH_GAP_SIZES,
  UI_GRAPH_OUTPUT_RENDER_MODES,
  type UiGraphAction,
  type UiGraph,
  type UiGraphComponent,
  type UiGraphId,
  normalizeUiGraphComponentIds,
} from './UiGraph.js';

export type UiGraphNormalizationIssue = {
  message: string;
  path: string;
};

export type UiGraphNormalizationOptions = {
  /** Disable only when validating raw data before known legacy ID repair. */
  repairComponentIds?: boolean;
};

export class UiGraphNormalizationError extends Error {
  constructor(readonly issues: readonly UiGraphNormalizationIssue[]) {
    super(`Invalid UI graph configuration: ${issues.map(formatUiGraphNormalizationIssue).join('; ')}`);
    this.name = 'UiGraphNormalizationError';
  }
}

export function formatUiGraphNormalizationIssue(issue: UiGraphNormalizationIssue): string {
  return `${issue.path}: ${issue.message}`;
}

/**
 * Validates every UI graph and component discriminator while applying only the
 * deterministic component-ID repair supported for legacy project snapshots.
 */
export function normalizeUiGraph(value: unknown, options: UiGraphNormalizationOptions = {}): UiGraph {
  const result = parseUiGraph(value, { ...options, expectedId: undefined });
  if (result.issues.length > 0) {
    throw new UiGraphNormalizationError(result.issues);
  }
  return result.uiGraph!;
}

export function normalizeUiGraphRecord(
  value: unknown,
  options: UiGraphNormalizationOptions = {},
): Record<UiGraphId, UiGraph> {
  if (!isRecord(value)) {
    throw new UiGraphNormalizationError([{ message: 'must be an object', path: 'Project uiGraphs' }]);
  }

  const issues: UiGraphNormalizationIssue[] = [];
  const replacements = new Map<string, UiGraph>();
  const uiGraphEntries = Object.entries(value);

  for (const [uiGraphId, uiGraph] of uiGraphEntries) {
    const result = parseUiGraph(uiGraph, { ...options, expectedId: uiGraphId });
    issues.push(...result.issues);
    if (result.uiGraph && result.uiGraph !== uiGraph) {
      replacements.set(uiGraphId, result.uiGraph);
    }
  }

  if (issues.length > 0) {
    throw new UiGraphNormalizationError(issues);
  }
  if (replacements.size === 0) {
    return value as Record<UiGraphId, UiGraph>;
  }
  return Object.fromEntries(
    uiGraphEntries.map(([uiGraphId, uiGraph]) => [uiGraphId, replacements.get(uiGraphId) ?? uiGraph]),
  ) as Record<UiGraphId, UiGraph>;
}

export function normalizeProjectUiGraphs<T extends { uiGraphs?: Project['uiGraphs'] }>(project: T): T {
  if (project.uiGraphs === undefined) {
    return project;
  }
  const uiGraphs = normalizeUiGraphRecord(project.uiGraphs);
  return uiGraphs === project.uiGraphs ? project : { ...project, uiGraphs };
}

type InternalNormalizationOptions = UiGraphNormalizationOptions & { expectedId?: string };
type UiGraphParseResult = { issues: UiGraphNormalizationIssue[]; uiGraph?: UiGraph };

function parseUiGraph(value: unknown, options: InternalNormalizationOptions): UiGraphParseResult {
  const issues: UiGraphNormalizationIssue[] = [];
  const graphLabel = getUiGraphLabel(value, options.expectedId);
  const graphPath = `UI graph "${graphLabel}"`;

  if (!isRecord(value)) {
    return { issues: [{ message: 'must be an object', path: graphPath }] };
  }

  requireNonEmptyString(value, 'id', graphPath, issues);
  requireString(value, 'name', graphPath, issues);
  optionalString(value, 'description', graphPath, issues);

  if (options.expectedId !== undefined && typeof value.id === 'string' && value.id !== options.expectedId) {
    issues.push({
      message: `must match its project key "${options.expectedId}"`,
      path: `${graphPath}.id`,
    });
  }

  if (!Array.isArray(value.components)) {
    issues.push({ message: 'must be an array', path: `${graphPath}.components` });
    return { issues };
  }

  validateComponents(value.components, graphPath, options, issues);
  if (issues.length > 0) {
    return { issues };
  }

  const uiGraph = value as UiGraph;
  return {
    issues,
    uiGraph: options.repairComponentIds === false ? uiGraph : normalizeUiGraphComponentIds(uiGraph),
  };
}

function validateComponents(
  components: unknown[],
  graphPath: string,
  options: UiGraphNormalizationOptions,
  issues: UiGraphNormalizationIssue[],
): void {
  const repairComponentIds = options.repairComponentIds !== false;
  const usedIds = new Set<string>();

  for (const [index, component] of components.entries()) {
    const componentPath = `${graphPath} component at index ${index}`;
    if (!isRecord(component)) {
      issues.push({ message: 'must be an object', path: componentPath });
      continue;
    }

    validateComponent(component, componentPath, issues);
    const rawComponentId = component.id;
    if (rawComponentId !== undefined && typeof rawComponentId !== 'string') {
      issues.push({ message: 'must be a string', path: `${componentPath}.id` });
      continue;
    }

    const componentId = rawComponentId ?? '';
    if (!componentId.trim()) {
      if (!repairComponentIds) {
        issues.push({ message: 'must be a non-empty string', path: `${componentPath}.id` });
      }
      continue;
    }

    if (usedIds.has(componentId)) {
      if (repairComponentIds) {
        continue;
      }
      issues.push({
        message: `duplicates component id "${componentId}"`,
        path: `${componentPath}.id`,
      });
      continue;
    }

    usedIds.add(componentId);
  }
}

function validateComponent(
  component: Record<string, unknown>,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  const componentType = component.type;
  if (typeof componentType !== 'string' || !hasOwn(UI_GRAPH_COMPONENT_VALIDATORS, componentType)) {
    issues.push({
      message:
        typeof componentType === 'string'
          ? `has unsupported type "${componentType}"`
          : 'must have a supported string type',
      path: `${path}.type`,
    });
    return;
  }

  UI_GRAPH_COMPONENT_VALIDATORS[componentType](component, path, issues);
}

type ShapeValidator = (value: Record<string, unknown>, path: string, issues: UiGraphNormalizationIssue[]) => void;

const UI_GRAPH_COMPONENT_VALIDATORS = {
  text(component, path, issues) {
    requireString(component, 'text', path, issues);
  },
  markdown(component, path, issues) {
    requireString(component, 'markdown', path, issues);
  },
  gap(component, path, issues) {
    requireEnum(component, 'size', UI_GRAPH_GAP_SIZES, path, issues);
  },
  input: validateInputComponent,
  textarea: validateInputComponent,
  dropdown: validateDropdownComponent,
  button(component, path, issues) {
    requireString(component, 'label', path, issues);
    validateAction(component.action, `${path}.action`, issues);
  },
  chat(component, path, issues) {
    optionalString(component, 'placeholder', path, issues);
    validateChatAction(component.action, `${path}.action`, issues);
  },
  output(component, path, issues) {
    optionalString(component, 'label', path, issues);
    requireString(component, 'stateKey', path, issues);
    optionalEnum(component, 'renderAs', UI_GRAPH_OUTPUT_RENDER_MODES, path, issues);
  },
} satisfies Record<UiGraphComponent['type'], ShapeValidator>;

function validateInputComponent(
  component: Record<string, unknown>,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  requireString(component, 'label', path, issues);
  requireString(component, 'stateKey', path, issues);
  optionalString(component, 'placeholder', path, issues);
  optionalString(component, 'defaultValue', path, issues);
}

function validateDropdownComponent(
  component: Record<string, unknown>,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  requireString(component, 'label', path, issues);
  requireString(component, 'stateKey', path, issues);

  if (!Array.isArray(component.items)) {
    issues.push({ message: 'must be an array', path: `${path}.items` });
    return;
  }

  component.items.forEach((item, index) => {
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) {
      issues.push({ message: 'must be an object', path: itemPath });
      return;
    }
    requireString(item, 'label', itemPath, issues);
    requireString(item, 'value', itemPath, issues);
  });
}

function validateAction(value: unknown, path: string, issues: UiGraphNormalizationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ message: 'must be an object', path });
    return;
  }
  const actionType = value.type;
  if (typeof actionType !== 'string' || !hasOwn(UI_GRAPH_ACTION_VALIDATORS, actionType)) {
    issues.push({ message: 'must be "runGraph"', path: `${path}.type` });
    return;
  }

  UI_GRAPH_ACTION_VALIDATORS[actionType](value, path, issues);
}

function validateChatAction(value: unknown, path: string, issues: UiGraphNormalizationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ message: 'must be an object', path });
    return;
  }
  if (value.type !== 'runGraph') {
    issues.push({ message: 'must be "runGraph"', path: `${path}.type` });
  }
  optionalString(value, 'graphId', path, issues);
  optionalString(value, 'userInputId', path, issues);
  optionalString(value, 'historyInputId', path, issues);
  optionalString(value, 'responseOutputId', path, issues);
  validateInputMappings(value.inputMappings, `${path}.inputMappings`, issues);
}

const UI_GRAPH_ACTION_VALIDATORS = {
  runGraph(value, path, issues) {
    optionalString(value, 'graphId', path, issues);
    optionalString(value, 'outputKey', path, issues);
    optionalString(value, 'outputStateKey', path, issues);
    validateInputMappings(value.inputMappings, `${path}.inputMappings`, issues);
    validateLegacyInputs(value.inputs, `${path}.inputs`, issues);
    validateOutputMappings(value.outputs, `${path}.outputs`, issues);
  },
} satisfies Record<UiGraphAction['type'], ShapeValidator>;

function validateInputMappings(value: unknown, path: string, issues: UiGraphNormalizationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ message: 'must be an array', path });
    return;
  }
  for (const [index, binding] of value.entries()) {
    const bindingPath = `${path} at index ${index}`;
    if (!isRecord(binding)) {
      issues.push({ message: 'must be an object', path: bindingPath });
      continue;
    }
    requireString(binding, 'inputKey', bindingPath, issues);
    requireString(binding, 'stateKey', bindingPath, issues);
  }
}

function validateLegacyInputs(value: unknown, path: string, issues: UiGraphNormalizationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    issues.push({ message: 'must be an object', path });
    return;
  }
  for (const [inputId, binding] of Object.entries(value)) {
    const bindingPath = `${path}[${JSON.stringify(inputId)}]`;
    if (!isRecord(binding)) {
      issues.push({ message: 'must be an object', path: bindingPath });
      continue;
    }
    if (binding.type === 'state') {
      requireString(binding, 'key', bindingPath, issues);
    } else if (binding.type === 'literal') {
      if (!Object.prototype.hasOwnProperty.call(binding, 'value')) {
        issues.push({ message: 'is required', path: `${bindingPath}.value` });
      }
    } else {
      issues.push({ message: 'must be "state" or "literal"', path: `${bindingPath}.type` });
    }
  }
}

function validateOutputMappings(value: unknown, path: string, issues: UiGraphNormalizationIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ message: 'must be an array', path });
    return;
  }
  for (const [index, binding] of value.entries()) {
    const bindingPath = `${path} at index ${index}`;
    if (!isRecord(binding)) {
      issues.push({ message: 'must be an object', path: bindingPath });
      continue;
    }
    optionalString(binding, 'outputKey', bindingPath, issues);
    requireString(binding, 'stateKey', bindingPath, issues);
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  if (typeof value[key] !== 'string') {
    issues.push({ message: 'must be a string', path: `${path}.${key}` });
  }
}

function requireNonEmptyString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  if (typeof value[key] !== 'string' || !value[key].trim()) {
    issues.push({ message: 'must be a non-empty string', path: `${path}.${key}` });
  }
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  if (value[key] !== undefined && typeof value[key] !== 'string') {
    issues.push({ message: 'must be a string when provided', path: `${path}.${key}` });
  }
}

function requireEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  if (typeof value[key] !== 'string' || !allowed.includes(value[key] as T[number])) {
    issues.push({ message: `must be one of: ${allowed.join(', ')}`, path: `${path}.${key}` });
  }
}

function optionalEnum<const T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
  path: string,
  issues: UiGraphNormalizationIssue[],
): void {
  if (value[key] !== undefined && (typeof value[key] !== 'string' || !allowed.includes(value[key] as T[number]))) {
    issues.push({ message: `must be one of: ${allowed.join(', ')}`, path: `${path}.${key}` });
  }
}

function getUiGraphLabel(value: unknown, expectedId: string | undefined): string {
  if (expectedId !== undefined) {
    return expectedId;
  }
  return isRecord(value) && typeof value.id === 'string' && value.id.trim() ? value.id : '<unknown>';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}
