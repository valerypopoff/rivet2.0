import type { ProjectId, RivetLLMProfileHealthStore } from '@valerypopoff/rivet2-node';

import type {
  LLMProfileHealthAdminEntry,
  LLMProfileHealthRecordingOutcome,
} from '../../../studio-server-shared/llmProfileHealthTypes.js';

export interface RivetStudioLLMProfileHealthStore extends RivetLLMProfileHealthStore {
  /** Project-scoped keyed reset used by the authenticated admin API. */
  resetProjectKey(projectId: ProjectId, key: string): Promise<boolean>;
  /** Operator view with recording-safe evidence for currently suspended profiles. */
  listAdmin(input: { projectId: ProjectId }): Promise<readonly LLMProfileHealthAdminEntry[]>;
  /** Joins normal recording persistence to pending profile-health evidence. */
  recordRecordingOutcome(input: LLMProfileHealthRecordingOutcome): Promise<void>;
  /** Removes a replay link after an operator explicitly deletes its recording. */
  markRecordingDeleted(recordingId: string): Promise<void>;
}
