import type { ProjectId, RivetLLMProfileHealthStore } from '@valerypopoff/rivet2-node';

export interface RivetStudioLLMProfileHealthStore extends RivetLLMProfileHealthStore {
  /** Project-scoped keyed reset used by the authenticated admin API. */
  resetProjectKey(projectId: ProjectId, key: string): Promise<boolean>;
}
