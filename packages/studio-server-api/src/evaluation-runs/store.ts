import { createHash } from "node:crypto";
import type { ProjectId } from "@valerypopoff/rivet2-node";
import {
  applyEvaluationLibraryMutation,
  getEvaluationLibraryResource,
  normalizeEvaluationLibrary,
  type EvaluationLibraryConflictResource,
  type EvaluationLibrary,
  type EvaluationLibraryMutation,
  type EvaluationLibraryMutationChange,
  type EvaluationLibraryResourceKind,
  type EvaluationLibraryResourceVersions,
  type EvaluationLibrarySyncSnapshot,
  type EvaluationRunEvent,
  type EvaluationStore,
} from "@valerypopoff/rivet2-evaluations";

/**
 * Server-owned Evaluations persistence. The library is instance-wide; run
 * evidence remains project-scoped so project deletion can remove it safely.
 */
export interface RivetStudioEvaluationStore extends EvaluationStore {
  applyRunEvent(event: EvaluationRunEvent): Promise<void>;
  getLibrarySnapshot(): Promise<EvaluationLibrarySnapshot>;
  getLibrarySyncSnapshot(): Promise<EvaluationLibrarySyncSnapshot>;
  replaceLibrary(input: {
    expectedRevision: number;
    library: EvaluationLibrary;
  }): Promise<EvaluationLibrarySnapshot>;
  mutateLibrary(input: EvaluationLibraryMutation): Promise<EvaluationLibrarySyncSnapshot>;
  importLegacyLibrary(input: {
    sourceFingerprint: string;
    library: EvaluationLibrary;
  }): Promise<EvaluationLibrarySnapshot>;
  deleteProject(projectId: ProjectId): Promise<void>;
}

export type EvaluationLibrarySnapshot = {
  revision: number;
  library: EvaluationLibrary;
};

export class EvaluationLibraryConflictError extends Error {
  constructor() {
    super(
      "The evaluation library changed in another browser. Reload before saving your changes.",
    );
    this.name = "EvaluationLibraryConflictError";
  }
}

/** A conflict scoped to only the suite or dataset resources a client changed. */
export class EvaluationLibraryResourceConflictError extends Error {
  readonly conflicts: readonly EvaluationLibraryConflictResource[];

  constructor(conflicts: readonly EvaluationLibraryConflictResource[]) {
    super("One or more evaluation resources changed in another browser.");
    this.name = "EvaluationLibraryResourceConflictError";
    this.conflicts = conflicts;
  }
}

export class EvaluationLibraryMutationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationLibraryMutationValidationError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function version(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

export function getEvaluationLibraryResourceVersions(
  library: EvaluationLibrary,
): EvaluationLibraryResourceVersions {
  const normalized = normalizeEvaluationLibrary(library);
  return {
    suites: Object.fromEntries(
      normalized.data.suites.map((suite) => [
        suite.id,
        version(getEvaluationLibraryResource(normalized, "suite", suite.id).value),
      ]),
    ),
    datasets: Object.fromEntries(normalized.datasets.map((dataset) => [dataset.id, version(dataset)])),
  };
}

export function toEvaluationLibrarySyncSnapshot(
  snapshot: EvaluationLibrarySnapshot,
): EvaluationLibrarySyncSnapshot {
  const library = normalizeEvaluationLibrary(snapshot.library);
  return {
    revision: snapshot.revision,
    library,
    resourceVersions: getEvaluationLibraryResourceVersions(library),
  };
}

function resourceVersion(
  versions: EvaluationLibraryResourceVersions,
  kind: EvaluationLibraryResourceKind,
  id: string,
): string | null {
  return kind === "suite" ? versions.suites[id] ?? null : versions.datasets[id] ?? null;
}

function resourceMatchesChange(
  library: EvaluationLibrary,
  change: EvaluationLibraryMutationChange,
): boolean {
  if (change.kind === "put-suite") {
    return canonicalJson(getEvaluationLibraryResource(library, "suite", change.id).value) === canonicalJson({
      suite: change.suite,
      baselines: change.baselines,
    });
  }
  if (change.kind === "delete-suite") {
    return getEvaluationLibraryResource(library, "suite", change.id).value === undefined;
  }
  if (change.kind === "put-dataset") {
    return canonicalJson(getEvaluationLibraryResource(library, "dataset", change.id).value) === canonicalJson(change.dataset);
  }
  return getEvaluationLibraryResource(library, "dataset", change.id).value === undefined;
}

function changedResource(change: EvaluationLibraryMutationChange): {
  kind: EvaluationLibraryResourceKind;
  id: string;
  expectedVersion: string | null;
} {
  return {
    kind: change.kind.endsWith("suite") ? "suite" : "dataset",
    id: change.id,
    expectedVersion: change.expectedVersion,
  };
}

function suiteReferencesField(suite: EvaluationLibrary["data"]["suites"][number], fieldIds: ReadonlySet<string>): boolean {
  return (
    suite.inputBindings.some((binding) => fieldIds.has(binding.datasetFieldId)) ||
    suite.assertions.some(
      (assertion) => assertion.expected.kind === "dataset-field" && fieldIds.has(assertion.expected.fieldId),
    ) ||
    suite.evaluators.some((evaluator) =>
      evaluator.inputBindings?.some(
        (binding) => binding.source.kind === "dataset-field" && fieldIds.has(binding.source.fieldId),
      ),
    )
  );
}

function assertMutationDependencies(
  before: EvaluationLibrary,
  after: EvaluationLibrary,
  changes: readonly EvaluationLibraryMutationChange[],
): void {
  for (const change of changes) {
    if (change.kind === "put-suite") {
      if (!after.datasets.some((dataset) => dataset.id === change.suite.datasetId)) {
        throw new EvaluationLibraryMutationValidationError(
          `Evaluation suite "${change.id}" references a dataset that is not available after this change.`,
        );
      }
      continue;
    }
    if (change.kind === "delete-dataset") {
      if (after.data.suites.some((suite) => suite.datasetId === change.id)) {
        throw new EvaluationLibraryMutationValidationError(
          `Cannot delete dataset "${change.id}" while an evaluation suite still references it.`,
        );
      }
      continue;
    }
    if (change.kind !== "put-dataset") continue;
    const previous = before.datasets.find((dataset) => dataset.id === change.id);
    if (!previous) continue;
    const retainedFieldIds = new Set(change.dataset.fields.map((field) => field.id));
    const removedFieldIds = new Set(
      previous.fields.map((field) => field.id).filter((id) => !retainedFieldIds.has(id)),
    );
    if (removedFieldIds.size === 0) continue;
    const danglingSuite = after.data.suites.find(
      (suite) => suite.datasetId === change.id && suiteReferencesField(suite, removedFieldIds),
    );
    if (danglingSuite) {
      throw new EvaluationLibraryMutationValidationError(
        `Cannot remove fields from dataset "${change.id}" while suite "${danglingSuite.id}" still references them.`,
      );
    }
  }
}

/**
 * Checks only the resources the caller changed, then applies the complete
 * batch. Both filesystem and managed stores call this while holding their
 * existing library lock, so unrelated resources can advance concurrently.
 */
export function applyCheckedEvaluationLibraryMutation(
  currentLibrary: EvaluationLibrary,
  input: EvaluationLibraryMutation,
): { library: EvaluationLibrary; changed: boolean } {
  const current = normalizeEvaluationLibrary(currentLibrary);
  const seen = new Set<string>();
  for (const change of input.changes) {
    const resource = changedResource(change);
    if (!resource.id || seen.has(`${resource.kind}:${resource.id}`)) {
      throw new EvaluationLibraryMutationValidationError("A library mutation may change each resource only once.");
    }
    seen.add(`${resource.kind}:${resource.id}`);
    if (
      (change.kind === "put-suite" && change.suite.id !== change.id) ||
      (change.kind === "put-dataset" && change.dataset.id !== change.id) ||
      (change.kind === "put-suite" && change.baselines.some((baseline) => baseline.suiteId !== change.id))
    ) {
      throw new EvaluationLibraryMutationValidationError("A library mutation resource ID does not match its payload.");
    }
  }
  if (input.changes.length === 0) return { library: current, changed: false };

  const versions = getEvaluationLibraryResourceVersions(current);
  const conflicts: EvaluationLibraryConflictResource[] = [];
  const effectiveChanges: EvaluationLibraryMutationChange[] = [];
  for (const change of input.changes) {
    const resource = changedResource(change);
    const currentVersion = resourceVersion(versions, resource.kind, resource.id);
    const alreadyApplied = resourceMatchesChange(current, change);
    if (currentVersion !== resource.expectedVersion && !alreadyApplied) {
      conflicts.push({ ...resource, currentVersion });
    } else if (!alreadyApplied) {
      effectiveChanges.push(change);
    }
  }
  if (conflicts.length > 0) throw new EvaluationLibraryResourceConflictError(conflicts);
  if (effectiveChanges.length === 0) return { library: current, changed: false };

  const library = applyEvaluationLibraryMutation(current, { changes: effectiveChanges });
  assertMutationDependencies(current, library, effectiveChanges);
  return { library, changed: canonicalJson(library) !== canonicalJson(current) };
}

export function mergeEvaluationLibraries(
  current: EvaluationLibrary,
  imported: EvaluationLibrary,
): EvaluationLibrary {
  const normalizedCurrent = normalizeEvaluationLibrary(current);
  const normalizedImported = normalizeEvaluationLibrary(imported);
  const mergeById = <T extends { id: string }>(
    primary: readonly T[],
    secondary: readonly T[],
  ): T[] => {
    const ids = new Set(primary.map((entry) => entry.id));
    return [...primary, ...secondary.filter((entry) => !ids.has(entry.id))];
  };

  return normalizeEvaluationLibrary({
    version: 1,
    data: {
      version: 1,
      suites: mergeById(
        normalizedCurrent.data.suites,
        normalizedImported.data.suites,
      ),
      baselines: mergeById(
        normalizedCurrent.data.baselines,
        normalizedImported.data.baselines,
      ),
    },
    datasets: mergeById(
      normalizedCurrent.datasets,
      normalizedImported.datasets,
    ),
    migratedLegacyProjectIds: Array.from(
      new Set([
        ...normalizedCurrent.migratedLegacyProjectIds,
        ...normalizedImported.migratedLegacyProjectIds,
      ]),
    ),
  });
}
