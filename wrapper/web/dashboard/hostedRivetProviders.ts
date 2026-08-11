import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { ProviderOverrides } from '../../../rivet/packages/app/src/host';
import { HostedDatasetProvider } from '../io/HostedDatasetProvider';
import { HostedIOProvider } from '../io/HostedIOProvider';
import {
  getDefaultEnvironmentProvider,
  getDefaultPathPolicyProvider,
} from '../overrides/utils/tauri';
import { RIVET_API_BASE_URL } from '../../shared/hosted-env';
import {
  createHttpLLMProfileHealthAdminProvider,
  createHttpRivetLLMProfileHealthStore,
} from '../../shared/llmProfileHealthHttpStore';

const hostedDatasetProvider = new HostedDatasetProvider();
const hostedLLMProfileHealthStore = createHttpRivetLLMProfileHealthStore({
  baseUrl: `${RIVET_API_BASE_URL}/workflows/llm-profile-health`,
});
const hostedLLMProfileHealthAdmin = createHttpLLMProfileHealthAdminProvider({
  baseUrl: `${RIVET_API_BASE_URL}/workflows/llm-profile-health`,
});

export function clearHostedDatasetsForProject(projectId: ProjectId): Promise<void> {
  return hostedDatasetProvider.deleteStoredDatasetsForProject(projectId);
}

export const hostedRivetProviders = {
  io: new HostedIOProvider(hostedDatasetProvider),
  datasets: hostedDatasetProvider,
  environment: getDefaultEnvironmentProvider(),
  pathPolicy: getDefaultPathPolicyProvider(),
  llmProfileHealthStore: hostedLLMProfileHealthStore,
  llmProfileHealthAdmin: hostedLLMProfileHealthAdmin,
} satisfies ProviderOverrides;
