import type { ProjectId } from '@valerypopoff/rivet2-core';
import { loadHostedPackagePlugin } from '../io/loadHostedPackagePlugin';
import { normalizeEvaluationLibrary, normalizeEvaluationRun } from '@valerypopoff/rivet2-evaluations';
import type { ProviderOverrides } from '../../app/src/host';
import { LocalEvaluationRunStore } from '../../app/src/providers/EvaluationRunStore';
import {
  getOpenedProjectSession,
  primeOpenedProjectSession,
  syncOpenedProjectSessionIds,
} from '../io/openedProjectSessionCache';
import { resolveHostedProjectTitle } from './openedProjectMetadata';
import { normalizeHostedProjectExecutorMode } from '../overrides/utils/hostedExecutorMode';
import { HostedDatasetProvider } from '../io/HostedDatasetProvider';
import { HostedIOProvider } from '../io/HostedIOProvider';
import { getDefaultEnvironmentProvider, getDefaultPathPolicyProvider } from '../overrides/utils/tauri';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import {
  createHttpLLMProfileHealthAdminProvider,
  createHttpRivetLLMProfileHealthStore,
} from '../../studio-server-shared/llmProfileHealthHttpStore';
import { createHttpEvaluationStore } from '../../studio-server-shared/evaluationRunHttpStore';
import { createHostedEvaluationCoordinator } from './hostedEvaluationCoordinator';
import { createHostedLocalExecutionRecordingPersistence } from './hostedLocalExecutionRecordingPersistence';
import {
  hostedSubgraphProjectCatalog,
  hostedSubgraphProjectLoader,
  persistHostedSubgraphProjectRun,
} from './hostedSubgraphProjects';

const hostedDatasetProvider = new HostedDatasetProvider();
const hostedLLMProfileHealthStore = createHttpRivetLLMProfileHealthStore({
  baseUrl: `${RIVET_API_BASE_URL}/workflows/llm-profile-health`,
});
export const hostedLLMProfileHealthAdmin = createHttpLLMProfileHealthAdminProvider({
  baseUrl: `${RIVET_API_BASE_URL}/workflows/llm-profile-health`,
});
export const hostedClassifierProfileHealthAdmin = createHttpLLMProfileHealthAdminProvider({
  baseUrl: `${RIVET_API_BASE_URL}/workflows/llm-profile-health`,
  family: 'classifier',
});
const hostedEvaluationStore = createHttpEvaluationStore({
  baseUrl: `${RIVET_API_BASE_URL}/workflows/evaluation-runs`,
  normalizeRun: normalizeEvaluationRun,
  normalizeLibrary: normalizeEvaluationLibrary,
  // Versions before the full hosted store kept suite/dataset definitions in
  // this browser database. The HTTP store imports that library idempotently.
  legacyLibrarySource: new LocalEvaluationRunStore(),
});

export function clearHostedDatasetsForProject(projectId: ProjectId): Promise<void> {
  return hostedDatasetProvider.deleteStoredDatasetsForProject(projectId);
}

export const hostedRivetProviders = {
  packagePluginLoader: loadHostedPackagePlugin,
  openedProjectSync: {
    mode: 'explicit-tabs',
    resolveTitle: resolveHostedProjectTitle,
    onOpenProjectIdsChanged: syncOpenedProjectSessionIds,
  },
  projectActivation: {
    getEvaluation: (info) => (info.fsPath ? getOpenedProjectSession(info.projectId, info.fsPath) : undefined),
    cacheEvaluation: (info, evaluation) => {
      if (info.fsPath) primeOpenedProjectSession(info.projectId, { fsPath: info.fsPath, evaluation });
    },
    normalizeExecutorMode: normalizeHostedProjectExecutorMode,
  },
  io: new HostedIOProvider(hostedDatasetProvider, hostedEvaluationStore),
  datasets: hostedDatasetProvider,
  environment: getDefaultEnvironmentProvider(),
  pathPolicy: getDefaultPathPolicyProvider(),
  llmProfileHealthStore: hostedLLMProfileHealthStore,
  localExecutionRecordingPersistence: createHostedLocalExecutionRecordingPersistence(),
  subgraphProjectCatalog: hostedSubgraphProjectCatalog,
  subgraphProjectLoader: hostedSubgraphProjectLoader,
  subgraphProjectRecordingPersistence: persistHostedSubgraphProjectRun,
  evaluationStore: hostedEvaluationStore,
  hostedEvaluationCoordinator: createHostedEvaluationCoordinator(),
} satisfies ProviderOverrides;
