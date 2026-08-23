import type { ProjectId } from "@valerypopoff/rivet2-node";
import type {
  EvaluationRun,
  EvaluationRunStore,
} from "@valerypopoff/rivet2-evaluations";

/**
 * Durable, project-scoped storage for Evaluation summaries. Full recordings
 * continue to use the existing recording service; this store deliberately
 * keeps the compact run/result document separate from project YAML.
 */
export interface RivetStudioEvaluationRunStore extends EvaluationRunStore {
  deleteProject(projectId: ProjectId): Promise<void>;
}
