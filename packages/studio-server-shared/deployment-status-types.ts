import type { RuntimeLibraryReplicaReadinessState } from './runtime-library-types.js';

/**
 * Deployment topology is provided by the launcher, not inferred from a
 * particular request or from the runtime-library registry. That keeps the UI
 * honest when a single host uses managed storage for a rehearsal.
 */
export type DeploymentTopology = 'single-host' | 'replicated';

export type DeploymentApiProfile = 'combined' | 'control' | 'execution' | 'evaluation';

export interface DeploymentStatus {
  topology: DeploymentTopology;
  apiProfile: DeploymentApiProfile;
  /**
   * Code-runtime synchronization is available only when replicas share the
   * managed runtime-library registry. It is not a Kubernetes pod-health API.
   */
  replicaReadiness: RuntimeLibraryReplicaReadinessState | null;
}
