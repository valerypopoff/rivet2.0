import { useStaticDataStore } from '../providers/ProvidersContext.js';

export { openStaticDataDatabase } from '../providers/StaticDataStore.js';

export function useStaticDataDatabase() {
  return useStaticDataStore();
}
