import {
  evaluationLibraryValueEquals,
  getEvaluationSuiteBundle,
  type EvaluationLibrary,
} from '@valerypopoff/rivet2-evaluations';

type ChangedResource = {
  kind: 'suite' | 'dataset';
  before: string | undefined;
  after: string | undefined;
  renameOnly: boolean;
};

const resourceLabel = (kind: ChangedResource['kind']) => `Evaluation ${kind}`;

function changedSuites(previous: EvaluationLibrary, next: EvaluationLibrary): ChangedResource[] {
  const ids = new Set([...previous.data.suites.map((suite) => suite.id), ...next.data.suites.map((suite) => suite.id)]);
  return [...ids].flatMap((id) => {
    const before = getEvaluationSuiteBundle(previous, id);
    const after = getEvaluationSuiteBundle(next, id);
    if (evaluationLibraryValueEquals(before, after)) return [];
    const renameOnly =
      before !== undefined &&
      after !== undefined &&
      before.suite.name !== after.suite.name &&
      evaluationLibraryValueEquals(before, {
        ...after,
        suite: { ...after.suite, name: before.suite.name },
      });
    return [{ kind: 'suite' as const, before: before?.suite.name, after: after?.suite.name, renameOnly }];
  });
}

function changedDatasets(previous: EvaluationLibrary, next: EvaluationLibrary): ChangedResource[] {
  const ids = new Set([...previous.datasets.map((dataset) => dataset.id), ...next.datasets.map((dataset) => dataset.id)]);
  return [...ids].flatMap((id) => {
    const before = previous.datasets.find((dataset) => dataset.id === id);
    const after = next.datasets.find((dataset) => dataset.id === id);
    if (evaluationLibraryValueEquals(before, after)) return [];
    const renameOnly =
      before !== undefined &&
      after !== undefined &&
      before.name !== after.name &&
      evaluationLibraryValueEquals(before, { ...after, name: before.name });
    return [{ kind: 'dataset' as const, before: before?.name, after: after?.name, renameOnly }];
  });
}

/** Returns one concise notification for a visible remote library update. */
export function describeEvaluationLibraryRemoteChange(previous: EvaluationLibrary, next: EvaluationLibrary): string | undefined {
  const changes = [...changedSuites(previous, next), ...changedDatasets(previous, next)];
  if (changes.length === 0) return undefined;
  if (changes.length > 1) {
    return `Evaluation library was updated by another administrator (${changes.length} resources changed).`;
  }

  const change = changes[0]!;
  const label = resourceLabel(change.kind);
  if (change.before === undefined) return `${label} "${change.after || 'Untitled'}" was added by another administrator.`;
  if (change.after === undefined) return `${label} "${change.before || 'Untitled'}" was removed by another administrator.`;
  if (change.renameOnly) {
    return `${label} "${change.before || 'Untitled'}" was renamed to "${change.after || 'Untitled'}" by another administrator.`;
  }
  return `${label} "${change.after || change.before || 'Untitled'}" was changed by another administrator.`;
}
