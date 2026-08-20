import { localizeEvaluationDataset, validateEvaluationDatasetForTransfer } from './datasetTransfer.js';
import { deserializeEvaluationProjectData } from './serialization.js';
import type { EvaluationDataset, EvaluationSuite } from './types.js';

const SUITE_BUNDLE_EXPORT_VERSION = 1;

type SuiteBundleExportEnvelope = {
  version: typeof SUITE_BUNDLE_EXPORT_VERSION;
  suite: EvaluationSuite;
  dataset: EvaluationDataset;
};

export type EvaluationSuiteBundle = {
  suite: EvaluationSuite;
  dataset: EvaluationDataset;
};

export type EvaluationSuiteBundleImportScope = {
  suiteId: string;
  datasetId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
}

function validateEvaluationSuite(value: unknown): EvaluationSuite {
  return deserializeEvaluationProjectData({ version: 1, suites: [value], baselines: [] }).suites[0]!;
}

function validateBundle(value: unknown): EvaluationSuiteBundle {
  if (
    !isRecord(value) ||
    value.version !== SUITE_BUNDLE_EXPORT_VERSION ||
    !isRecord(value.suite) ||
    !isRecord(value.dataset)
  ) {
    throw new Error(`Expected an evaluation suite export with version ${SUITE_BUNDLE_EXPORT_VERSION}.`);
  }
  const suite = validateEvaluationSuite(value.suite);
  const dataset = validateEvaluationDatasetForTransfer(value.dataset);
  if (suite.datasetId !== dataset.id) {
    throw new Error('The evaluation suite export must include the dataset referenced by its suite.');
  }
  return { suite, dataset };
}

/**
 * A portable suite bundle includes the suite definition and its referenced
 * dataset. It intentionally excludes graphs, baselines, recordings, and run
 * history, which belong to the destination project or its run store.
 */
export function serializeEvaluationSuiteBundleJson(suite: EvaluationSuite, dataset: EvaluationDataset): string {
  const bundle = validateBundle({ version: SUITE_BUNDLE_EXPORT_VERSION, suite, dataset });
  return JSON.stringify(
    { version: SUITE_BUNDLE_EXPORT_VERSION, ...bundle } satisfies SuiteBundleExportEnvelope,
    null,
    2,
  );
}

/**
 * Imports a bundle as new local evaluation resources. Field and case IDs remain stable
 * so the imported suite's bindings and expected-value references still point
 * to its imported dataset; suite and dataset identities are always supplied by
 * the destination to avoid overwriting existing resources.
 */
export function deserializeEvaluationSuiteBundleJson(
  source: string,
  scope: EvaluationSuiteBundleImportScope,
): EvaluationSuiteBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Evaluation suite JSON is not valid JSON.');
  }

  requireNonEmptyString(scope.suiteId, 'suiteId');
  requireNonEmptyString(scope.datasetId, 'datasetId');

  const bundle = validateBundle(parsed);
  const dataset = localizeEvaluationDataset(bundle.dataset, scope.datasetId);
  return {
    dataset,
    suite: {
      ...bundle.suite,
      id: scope.suiteId,
      datasetId: dataset.id,
    },
  };
}
