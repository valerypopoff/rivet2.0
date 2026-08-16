import { assertPortableJson, fingerprintEvaluationDataset } from './canonical.js';
import type { EvaluationDataset, EvaluationDatasetCase, EvaluationDatasetField } from './types.js';

const DATASET_EXPORT_VERSION = 1;

type DatasetExportEnvelope = {
  version: typeof DATASET_EXPORT_VERSION;
  dataset: EvaluationDataset;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

function parseFields(value: unknown): EvaluationDatasetField[] {
  if (!Array.isArray(value)) throw new Error('Evaluation dataset fields must be an array.');
  const ids = new Set<string>();
  return value.map((field, index) => {
    if (!isRecord(field)) throw new Error(`fields[${index}] must be an object.`);
    const id = requireString(field.id, `fields[${index}].id`);
    if (ids.has(id)) throw new Error(`Evaluation dataset has duplicate field id "${id}".`);
    ids.add(id);
    const role = field.role;
    if (role !== 'input' && role !== 'expected' && role !== 'metadata') {
      throw new Error(`fields[${index}].role must be input, expected, or metadata.`);
    }
    if (field.description !== undefined && typeof field.description !== 'string') {
      throw new Error(`fields[${index}].description must be a string.`);
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      throw new Error(`fields[${index}].required must be a boolean.`);
    }
    return {
      id,
      name: requireString(field.name, `fields[${index}].name`),
      dataType: requireString(field.dataType, `fields[${index}].dataType`),
      role,
      ...(typeof field.description === 'string' ? { description: field.description } : {}),
      ...(typeof field.required === 'boolean' ? { required: field.required } : {}),
    };
  });
}

function parseCases(value: unknown, fieldIds: ReadonlySet<string>): EvaluationDatasetCase[] {
  if (!Array.isArray(value)) throw new Error('Evaluation dataset cases must be an array.');
  const ids = new Set<string>();
  return value.map((testCase, index) => {
    if (!isRecord(testCase)) throw new Error(`cases[${index}] must be an object.`);
    const id = requireString(testCase.id, `cases[${index}].id`);
    if (ids.has(id)) throw new Error(`Evaluation dataset has duplicate case id "${id}".`);
    ids.add(id);
    if (!isRecord(testCase.values)) throw new Error(`cases[${index}].values must be an object.`);
    for (const [fieldId, fieldValue] of Object.entries(testCase.values)) {
      if (!fieldIds.has(fieldId)) throw new Error(`cases[${index}].values references unknown field "${fieldId}".`);
      assertPortableJson(fieldValue, `cases[${index}].values.${fieldId}`);
    }
    if (testCase.tags !== undefined && (!Array.isArray(testCase.tags) || testCase.tags.some((tag) => typeof tag !== 'string'))) {
      throw new Error(`cases[${index}].tags must be an array of strings.`);
    }
    if (testCase.note !== undefined && typeof testCase.note !== 'string') throw new Error(`cases[${index}].note must be a string.`);
    if (testCase.enabled !== undefined && typeof testCase.enabled !== 'boolean') throw new Error(`cases[${index}].enabled must be a boolean.`);
    return {
      id,
      name: requireString(testCase.name, `cases[${index}].name`),
      values: testCase.values as EvaluationDatasetCase['values'],
      ...(typeof testCase.enabled === 'boolean' ? { enabled: testCase.enabled } : {}),
      ...(Array.isArray(testCase.tags) ? { tags: testCase.tags as string[] } : {}),
      ...(typeof testCase.note === 'string' ? { note: testCase.note } : {}),
    };
  });
}

/**
 * Validates the durable .rivet-data representation as well as file imports.
 * A caller may provide a scope when importing into an existing dataset, which
 * deliberately retains that dataset/project identity while accepting the
 * incoming field and case definitions.
 */
export function validateEvaluationDataset(
  value: unknown,
  scope?: Pick<EvaluationDataset, 'id' | 'projectId'>,
): EvaluationDataset {
  if (!isRecord(value)) throw new Error('Evaluation dataset must be an object.');
  const fields = parseFields(value.fields);
  const dataset: EvaluationDataset = {
    id: scope?.id ?? requireString(value.id, 'dataset.id'),
    projectId: scope?.projectId ?? (requireString(value.projectId, 'dataset.projectId') as EvaluationDataset['projectId']),
    name: requireString(value.name, 'dataset.name'),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    fields,
    cases: parseCases(value.cases, new Set(fields.map((field) => field.id))),
  };
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error('dataset.description must be a string.');
  }
  return { ...dataset, contentFingerprint: fingerprintEvaluationDataset(dataset) };
}

/**
 * Portable interchange envelope for a complete evaluation dataset. CSV is
 * useful for case rows; JSON is the lossless form that also carries field
 * roles and Rivet data types.
 */
export function serializeEvaluationDatasetJson(dataset: EvaluationDataset): string {
  const validated = validateEvaluationDataset(dataset);
  return JSON.stringify({ version: DATASET_EXPORT_VERSION, dataset: validated } satisfies DatasetExportEnvelope, null, 2);
}

/**
 * Reads a dataset export into the selected project scope. Import deliberately
 * keeps incoming field/case IDs but never lets a file switch project or
 * dataset identity: existing suites stay attached to the dataset being
 * replaced.
 */
export function deserializeEvaluationDatasetJson(
  source: string,
  scope: Pick<EvaluationDataset, 'id' | 'projectId'>,
): EvaluationDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Evaluation dataset JSON is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== DATASET_EXPORT_VERSION || !isRecord(parsed.dataset)) {
    throw new Error(`Expected an evaluation dataset export with version ${DATASET_EXPORT_VERSION}.`);
  }
  return validateEvaluationDataset(parsed.dataset, scope);
}
