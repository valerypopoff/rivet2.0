import type { useDeploymentStatus } from '../../useDeploymentStatus';
import { DeploymentReplicaReadinessPanel } from '../../DeploymentReplicaReadinessPanel';
import type { DeploymentStatus } from '../../../../studio-server-shared/deployment-status-types';
import './DeploymentStatusSettingsTab.css';

function currentServerRole(profile: DeploymentStatus['apiProfile']): string {
  return profile === 'combined' ? 'Combined editor and endpoint server' :
    profile === 'control' ? 'Editor and dashboard control plane' :
      profile === 'execution' ? 'Published endpoint execution plane' : 'Evaluation worker';
}

export function DeploymentStatusSettingsTab({ deployment }: { deployment: ReturnType<typeof useDeploymentStatus> }) {
  const { status, loading, error, nowMs, clearingStaleReplicas, cleanupMessage, clearStaleReplicas } = deployment;

  return (
    <div className="project-settings-tab-panel deployment-status-panel" role="tabpanel">
      {loading && !status ? <div className="deployment-status-loading">Loading deployment status...</div> : null}
      {error ? <div className="project-settings-error deployment-status-error">{error}</div> : null}
      {cleanupMessage ? <div className="project-settings-success deployment-status-cleanup-message" role="status">{cleanupMessage}</div> : null}
      {status ? (
        <>
          <section className="app-settings-section deployment-status-section" aria-label="Deployment topology">
            <div className="app-settings-section-title">Deployment topology</div>
            <div className={`deployment-status-topology-card ${status.topology}`}>
              <div className="deployment-status-topology-title">
                {status.topology === 'single-host' ? 'Single-host deployment' : 'Replicated deployment'}
              </div>
              <div className="deployment-status-topology-copy">
                {status.topology === 'single-host'
                  ? 'This server runs as one combined API process for the editor, dashboard, and published endpoints. There is no second Rivet replica or automatic failover; restarting this host makes all of those surfaces unavailable until it returns.'
                  : 'This server is part of a split deployment. Published endpoints can use separate execution replicas while the editor and dashboard stay on the control plane. Replica counts are configured by the deployment, not in this Settings modal.'}
              </div>
              <div className="deployment-status-current-role">This server: {currentServerRole(status.apiProfile)}</div>
            </div>
          </section>

          {status.topology === 'replicated' ? (
            status.replicaReadiness ? (
              <DeploymentReplicaReadinessPanel
                readiness={status.replicaReadiness}
                nowMs={nowMs}
                clearingStaleReplicas={clearingStaleReplicas}
                onClearStaleReplicas={() => void clearStaleReplicas()}
              />
            ) : (
              <section className="app-settings-section deployment-status-section" aria-label="Code runtime synchronization">
                <div className="app-settings-section-title">Code runtime synchronization</div>
                <div className="deployment-status-empty-card">
                  No replica synchronization reports are available yet. This can happen while a managed deployment is starting or if Code-runtime replica reporting is not configured.
                </div>
              </section>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
