import { canonicalStringify } from './canonical.js';
import { normalizeEvaluationLibrary } from './library.js';
import type {
  EvaluationLibrary,
  EvaluationLibraryMutation,
  EvaluationLibraryMutationChange,
  EvaluationLibraryResourceValue,
  EvaluationLibraryResourceVersions,
  EvaluationLibrarySuiteBundle,
} from './types.js';

export type { EvaluationLibraryResourceValue, EvaluationLibrarySuiteBundle } from './types.js';

/**
 * Matches the server's canonical resource versioning while retaining the
 * meaningful distinction between an absent resource and a present JSON value.
 */
export function evaluationLibraryValueEquals(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonicalStringify(left) === canonicalStringify(right);
}

export function getEvaluationSuiteBundle(
  library: EvaluationLibrary,
  id: string,
): EvaluationLibrarySuiteBundle | undefined {
  const suite = library.data.suites.find((candidate) => candidate.id === id);
  if (!suite) return undefined;
  return {
    suite,
    baselines: library.data.baselines.filter((baseline) => baseline.suiteId === id),
  };
}

export function getEvaluationLibraryResource(
  library: EvaluationLibrary,
  kind: 'suite' | 'dataset',
  id: string,
): EvaluationLibraryResourceValue {
  if (kind === 'suite') return { kind, id, value: getEvaluationSuiteBundle(library, id) };
  return { kind, id, value: library.datasets.find((dataset) => dataset.id === id) };
}

function resourceIds(library: EvaluationLibrary, kind: 'suite' | 'dataset'): Set<string> {
  return new Set(kind === 'suite' ? library.data.suites.map((suite) => suite.id) : library.datasets.map((dataset) => dataset.id));
}

/**
 * Builds the smallest resource batch between two already normalized library
 * snapshots. Legacy migration metadata deliberately has its own explicit
 * server operation and is not silently folded into an editor mutation.
 */
export function diffEvaluationLibraryMutation(
  previous: EvaluationLibrary,
  next: EvaluationLibrary,
  versions: EvaluationLibraryResourceVersions,
): EvaluationLibraryMutation | undefined {
  const changes: EvaluationLibraryMutationChange[] = [];
  for (const kind of ['dataset', 'suite'] as const) {
    const ids = new Set([...resourceIds(previous, kind), ...resourceIds(next, kind)]);
    for (const id of [...ids].sort()) {
      if (kind === 'suite') {
        const before = getEvaluationSuiteBundle(previous, id);
        const after = getEvaluationSuiteBundle(next, id);
        if (evaluationLibraryValueEquals(before, after)) continue;
        const currentVersion = versions.suites[id];
        if (before !== undefined && currentVersion === undefined) {
          throw new Error(`The suite "${id}" has no synchronization version.`);
        }
        const expectedVersion = before === undefined ? null : currentVersion!;
        if (after === undefined) {
          changes.push({ kind: 'delete-suite', id, expectedVersion: expectedVersion! });
        } else {
          changes.push({
            kind: 'put-suite',
            id,
            expectedVersion,
            suite: after.suite,
            baselines: after.baselines,
          });
        }
      } else {
        const before = previous.datasets.find((dataset) => dataset.id === id);
        const after = next.datasets.find((dataset) => dataset.id === id);
        if (evaluationLibraryValueEquals(before, after)) continue;
        const currentVersion = versions.datasets[id];
        if (before !== undefined && currentVersion === undefined) {
          throw new Error(`The dataset "${id}" has no synchronization version.`);
        }
        const expectedVersion = before === undefined ? null : currentVersion!;
        if (after === undefined) {
          changes.push({ kind: 'delete-dataset', id, expectedVersion: expectedVersion! });
        } else {
          changes.push({ kind: 'put-dataset', id, expectedVersion, dataset: after });
        }
      }
    }
  }
  return changes.length === 0 ? undefined : { changes };
}

function replaceById<T extends { id: string }>(items: readonly T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index === -1) return [...items, value];
  return items.map((item) => (item.id === value.id ? value : item));
}

/** Applies a server-validated resource batch while preserving unrelated resources. */
export function applyEvaluationLibraryMutation(
  library: EvaluationLibrary,
  mutation: EvaluationLibraryMutation,
): EvaluationLibrary {
  let suites = library.data.suites;
  let baselines = library.data.baselines;
  let datasets = library.datasets;
  for (const change of mutation.changes) {
    switch (change.kind) {
      case 'put-suite':
        suites = replaceById(suites, change.suite);
        baselines = [...baselines.filter((baseline) => baseline.suiteId !== change.id), ...change.baselines];
        break;
      case 'delete-suite':
        suites = suites.filter((suite) => suite.id !== change.id);
        baselines = baselines.filter((baseline) => baseline.suiteId !== change.id);
        break;
      case 'put-dataset':
        datasets = replaceById(datasets, change.dataset);
        break;
      case 'delete-dataset':
        datasets = datasets.filter((dataset) => dataset.id !== change.id);
        break;
    }
  }
  return normalizeEvaluationLibrary({
    version: 1,
    data: { version: 1, suites, baselines },
    datasets,
    migratedLegacyProjectIds: library.migratedLegacyProjectIds,
  });
}
