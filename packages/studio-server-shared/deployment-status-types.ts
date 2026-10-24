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
  /** Deployment policy, not a health observation or current Kubernetes count. */
  controlPlaneAvailability?: {
    mode: 'replicated' | 'singleton' | 'singleton-overlap';
    maintenance: 'dedicated' | 'embedded';
    developerInterruptionAllowed: boolean;
  };
  /**
   * Code-runtime synchronization is available only when replicas share the
   * managed runtime-library registry. It is not a Kubernetes pod-health API.
   */
  replicaReadiness: RuntimeLibraryReplicaReadinessState | null;
  /** Separate from developer serving readiness; only present in overlap mode. */
  housekeepingReadiness?: { state: 'ready' | 'handover' | 'unavailable'; ownerPodUid?: string };
  /** Observed developer API readiness, not the runtime-library synchronization registry. */
  servingReadiness?: { ready: boolean; state: string; checkedAt: string | null; code?: string };
}
