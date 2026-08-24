import type { ProjectId } from "@valerypopoff/rivet2-node";
import {
  normalizeEvaluationLibrary,
  type EvaluationLibrary,
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
  replaceLibrary(input: {
    expectedRevision: number;
    library: EvaluationLibrary;
  }): Promise<EvaluationLibrarySnapshot>;
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
