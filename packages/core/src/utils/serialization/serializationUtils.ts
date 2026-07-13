import type { Project } from '../../index.js';
import type * as yaml from 'yaml';
import {
  formatUiGraphNormalizationIssue,
  normalizeUiGraphRecord,
  UiGraphNormalizationError,
} from '../../model/UiGraphNormalization.js';
import { prepareSerializedInput } from './serializationInput.js';

/** Additional data that has been attached to a project/graph, for use by plugins, etc. */
export type AttachedData = Record<string, unknown>;

export type ProjectValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

/** Validates a deserialized project structure. Returns errors for structural problems. */
export function validateProject(project: unknown): ProjectValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!project || typeof project !== 'object') {
    return { valid: false, errors: ['Project is not an object'], warnings };
  }

  const p = project as Record<string, unknown>;

  // Metadata checks
  if (!p.metadata || typeof p.metadata !== 'object') {
    errors.push('Missing project metadata');
  } else {
    const meta = p.metadata as Record<string, unknown>;
    if (!meta.id) errors.push('Missing project metadata.id');
    if (!meta.title) errors.push('Missing project metadata.title');
  }

  // Graphs checks
  if (!p.graphs || typeof p.graphs !== 'object') {
    errors.push('Missing or invalid project graphs');
  } else {
    const graphs = p.graphs as Record<string, unknown>;
    for (const [graphId, graph] of Object.entries(graphs)) {
      if (!graph || typeof graph !== 'object') {
        errors.push(`Graph "${graphId}": not an object`);
        continue;
      }

      const g = graph as Record<string, unknown>;

      if (!Array.isArray(g.nodes)) {
        errors.push(`Graph "${graphId}": nodes is not an array`);
      } else {
        for (let i = 0; i < g.nodes.length; i++) {
          const node = g.nodes[i] as Record<string, unknown> | undefined;
          if (!node || typeof node !== 'object') {
            errors.push(`Graph "${graphId}": node at index ${i} is not an object`);
            continue;
          }
          if (!node.id) errors.push(`Graph "${graphId}": node at index ${i} missing id`);
          if (!node.type) errors.push(`Graph "${graphId}": node "${node.id ?? i}" missing type`);
        }
      }

      if (!Array.isArray(g.connections)) {
        errors.push(`Graph "${graphId}": connections is not an array`);
      } else {
        for (let i = 0; i < g.connections.length; i++) {
          const conn = g.connections[i] as Record<string, unknown> | undefined;
          if (!conn || typeof conn !== 'object') {
            errors.push(`Graph "${graphId}": connection at index ${i} is not an object`);
            continue;
          }
          if (!conn.inputNodeId || !conn.outputNodeId) {
            warnings.push(`Graph "${graphId}": connection at index ${i} missing node reference`);
          }
        }
      }
    }
  }

  if (p.uiGraphs != null) {
    validateUiGraphs(p.uiGraphs, errors);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateUiGraphs(uiGraphs: unknown, errors: string[]): void {
  try {
    normalizeUiGraphRecord(uiGraphs, { repairComponentIds: false });
  } catch (error) {
    if (error instanceof UiGraphNormalizationError) {
      errors.push(...error.issues.map(formatUiGraphNormalizationIssue));
      return;
    }
    throw error;
  }
}

/** Quick structural check - throws on invalid project. */
export function doubleCheckProject(project: Project): void {
  const result = validateProject(project);
  if (!result.valid) {
    throw new Error(`Invalid project file: ${result.errors.join('; ')}`);
  }
}

export function yamlProblem(err: yaml.YAMLError): never {
  const { code, message, pos, linePos } = err;
  throw new Error(`YAML error: ${code} ${message} at ${pos} ${linePos}`);
}

export type SerializationVersion = 1 | 2 | 3 | 4;

export function detectSerializationVersion(data: unknown): SerializationVersion {
  return prepareSerializedInput(data).version;
}
