import type { Pool } from 'pg';
import type { SubgraphProjectTarget } from '@valerypopoff/rivet2-node';
import type { WorkflowExecutionSources } from '../data-backend.js';
import { PostgresRivetLLMProfileHealthStore } from '../../../llm-profile-health/managed-store.js';
import { PostgresRivetEvaluationStore } from '../../../evaluation-runs/managed-store.js';
import { HostedEvaluationCoordinator } from '../../../evaluation-runs/hosted-coordinator.js';
import { createHostedEvaluationGraphRunner } from '../../../evaluation-runs/hosted-execution.js';
import { getHostedEvaluationsCoordinatorConfig } from '../../../hosted-evaluations-config.js';

/** Serving composition supplies operational resources; persistence/migration does not construct them.
 * Factories only construct wrappers over the supplied pool. Starting producers
 * remains the explicit serving startup step, after storage/runtime readiness. */
export type ManagedWorkflowOperations = {
  profileHealth: PostgresRivetLLMProfileHealthStore;
  evaluations: PostgresRivetEvaluationStore;
  coordinator?: HostedEvaluationCoordinator;
};
export type ManagedWorkflowOperationsFactory = (input: {
  pool: Pool;
  backgroundTasks: boolean;
  sources: Pick<WorkflowExecutionSources, 'createProjectReferenceLoader' | 'loadSubgraphTarget'> & {
    validateSubgraphTarget(target: SubgraphProjectTarget): Promise<void>;
  };
}) => ManagedWorkflowOperations;

export const createManagedWorkflowOperations: ManagedWorkflowOperationsFactory = ({
  pool,
  sources,
  backgroundTasks,
}) => {
  const profileHealth = new PostgresRivetLLMProfileHealthStore(pool);
  const evaluations = new PostgresRivetEvaluationStore(pool);
  const coordinator = backgroundTasks
    ? new HostedEvaluationCoordinator({
        pool,
        runStore: evaluations,
        config: getHostedEvaluationsCoordinatorConfig(),
        runGraph: createHostedEvaluationGraphRunner({
          evaluationStore: evaluations,
          llmProfileHealthStore: profileHealth,
          createProjectReferenceLoader: () => Promise.resolve(sources.createProjectReferenceLoader()),
          createSubgraphProjectLoader: () => ({
            loadTarget: (target) => sources.loadSubgraphTarget(target),
            validateTarget: (target) => sources.validateSubgraphTarget(target),
          }),
        }),
      })
    : undefined;
  return { profileHealth, evaluations, coordinator };
};
