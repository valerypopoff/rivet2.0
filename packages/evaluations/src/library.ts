import { localizeEvaluationDataset } from './datasetTransfer.js';
import { createEmptyEvaluationProjectData, deserializeEvaluationProjectData } from './serialization.js';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { EvaluationLibrary, EvaluationProjectData } from './types.js';

export function createEmptyEvaluationLibrary(): EvaluationLibrary {
  return {
    version: 1,
    data: createEmptyEvaluationProjectData(),
    datasets: [],
    migratedLegacyProjectIds: [],
  };
}

/**
 * Repairs a library resource-by-resource so one malformed suite, baseline, or
 * dataset cannot hide unrelated valid resources. The top-level persistence
 * envelope is validated by the owning store before this function is called.
 */
export function normalizeEvaluationLibrary(value: unknown): EvaluationLibrary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return createEmptyEvaluationLibrary();
  const candidate = value as Partial<EvaluationLibrary>;
  let data = createEmptyEvaluationProjectData();
  try {
    data = deserializeEvaluationProjectData(candidate.data);
  } catch {
    const dataCandidate =
      typeof candidate.data === 'object' && candidate.data !== null && !Array.isArray(candidate.data)
        ? (candidate.data as Partial<EvaluationProjectData>)
        : undefined;
    const suites = Array.isArray(dataCandidate?.suites)
      ? dataCandidate.suites.flatMap((suite) => {
          try {
            return [deserializeEvaluationProjectData({ version: 1, suites: [suite], baselines: [] }).suites[0]!];
          } catch {
            return [];
          }
        })
      : [];
    const baselines = Array.isArray(dataCandidate?.baselines)
      ? dataCandidate.baselines.flatMap((baseline) => {
          try {
            return [deserializeEvaluationProjectData({ version: 1, suites: [], baselines: [baseline] }).baselines[0]!];
          } catch {
            return [];
          }
        })
      : [];
    const suiteIds = new Set(suites.map((suite) => suite.id));
    data = { version: 1, suites, baselines: baselines.filter((baseline) => suiteIds.has(baseline.suiteId)) };
  }

  const datasets = Array.isArray(candidate.datasets)
    ? candidate.datasets.flatMap((dataset) => {
        try {
          return [localizeEvaluationDataset(dataset)];
        } catch {
          return [];
        }
      })
    : [];

  const suites = uniqueById(data.suites);
  const suiteIds = new Set(suites.map((suite) => suite.id));

  return {
    version: 1,
    data: {
      ...data,
      suites,
      baselines: uniqueById(data.baselines).filter((baseline) => suiteIds.has(baseline.suiteId)),
    },
    datasets: uniqueById(datasets),
    migratedLegacyProjectIds: Array.isArray(candidate.migratedLegacyProjectIds)
      ? Array.from(new Set(candidate.migratedLegacyProjectIds.filter((id): id is ProjectId => typeof id === 'string')))
      : [],
  };
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}
