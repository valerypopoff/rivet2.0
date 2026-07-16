import type { z } from 'zod';
import type { Project } from './Project.js';
import { type UiGraph, type UiGraphId, normalizeUiGraphComponentIds } from './UiGraph.js';
import { UI_GRAPH_COMPONENT_SCHEMA, UI_GRAPH_ENVELOPE_SCHEMA } from './UiGraphSchema.js';

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
  const graphPath = `UI graph "${getUiGraphLabel(value, options.expectedId)}"`;
  if (!isRecord(value)) {
    return { issues: [{ message: 'must be an object', path: graphPath }] };
  }

  const envelopeResult = UI_GRAPH_ENVELOPE_SCHEMA.safeParse(value);
  const issues = envelopeResult.success ? [] : mapSchemaIssues(envelopeResult.error.issues, graphPath);
  if (options.expectedId !== undefined && typeof value.id === 'string' && value.id !== options.expectedId) {
    issues.push({ message: `must match its project key "${options.expectedId}"`, path: `${graphPath}.id` });
  }
  if (!Array.isArray(value.components)) {
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

    const result = UI_GRAPH_COMPONENT_SCHEMA.safeParse(component);
    if (!result.success) {
      issues.push(...mapComponentSchemaIssues(result.error.issues, componentPath, component.type));
    }

    const rawComponentId = component.id;
    if (rawComponentId !== undefined && typeof rawComponentId !== 'string') {
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
      if (!repairComponentIds) {
        issues.push({ message: `duplicates component id "${componentId}"`, path: `${componentPath}.id` });
      }
      continue;
    }
    usedIds.add(componentId);
  }
}

function mapComponentSchemaIssues(
  schemaIssues: readonly z.core.$ZodIssue[],
  path: string,
  componentType: unknown,
): UiGraphNormalizationIssue[] {
  return schemaIssues.map((issue) => ({
    message:
      issue.path.length === 1 && issue.path[0] === 'type'
        ? typeof componentType === 'string'
          ? `has unsupported type "${componentType}"`
          : 'must have a supported string type'
        : issue.message,
    path: formatSchemaPath(path, issue.path),
  }));
}

function mapSchemaIssues(schemaIssues: readonly z.core.$ZodIssue[], path: string): UiGraphNormalizationIssue[] {
  return schemaIssues.map((issue) => ({ message: issue.message, path: formatSchemaPath(path, issue.path) }));
}

function formatSchemaPath(basePath: string, schemaPath: PropertyKey[]): string {
  let path = basePath;
  for (let index = 0; index < schemaPath.length; index += 1) {
    const segment = schemaPath[index]!;
    const previous = schemaPath[index - 1];
    if (typeof segment === 'number') {
      path += previous === 'items' ? `[${segment}]` : ` at index ${segment}`;
    } else if (typeof previous === 'string' && previous === 'inputs') {
      path += `[${JSON.stringify(segment)}]`;
    } else {
      path += `.${String(segment)}`;
    }
  }
  return path;
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
