import type { useDeploymentStatus } from '../../useDeploymentStatus';
import { DeploymentReplicaReadinessPanel } from '../../DeploymentReplicaReadinessPanel';
import type { DeploymentStatus } from '../../../../studio-server-shared/deployment-status-types';
import './DeploymentStatusSettingsTab.css';
import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import type { usePublishedExecutionForm } from '../usePublishedExecutionForm';
import { SettingsActions } from '../SettingsControls';

function currentServerRole(profile: DeploymentStatus['apiProfile']): string {
  return profile === 'combined'
    ? 'Combined editor and endpoint server'
    : profile === 'control'
      ? 'Editor and dashboard control plane'
      : profile === 'execution'
        ? 'Published endpoint execution plane'
        : 'Evaluation worker';
}

export function DeploymentStatusSettingsTab({
  deployment,
  execution,
}: {
  deployment: ReturnType<typeof useDeploymentStatus>;
  execution: ReturnType<typeof usePublishedExecutionForm>;
}) {
  const { status, loading, error, nowMs, clearingStaleReplicas, cleanupMessage, clearStaleReplicas } = deployment;

  return (
    <div className="project-settings-tab-panel deployment-status-panel" role="tabpanel">
      {loading && !status ? <div className="deployment-status-loading">Loading deployment status...</div> : null}
      {error ? <div className="project-settings-error deployment-status-error">{error}</div> : null}
      {cleanupMessage ? (
        <div className="project-settings-success deployment-status-cleanup-message" role="status">
          {cleanupMessage}
        </div>
      ) : null}
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
            <section
              className="app-settings-section deployment-status-section"
              aria-label="Published execution concurrency"
            >
              <div className="app-settings-section-title">Published execution concurrency</div>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Concurrent runs per execution Pod</span>
                <TextField
                  aria-label="Concurrent runs per execution Pod"
                  type="number"
                  min={1}
                  max={10000}
                  step={1}
                  value={execution.form.value}
                  isDisabled={execution.controlsDisabled}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    execution.setForm((form) => ({ ...form, value, useDefault: false }));
                    execution.clearFeedback();
                  }}
                />
                <span className="app-settings-field-help">
                  Applies to new published endpoint, web-app and scheduled runs on each execution Pod. Running work
                  finishes normally. Changes reach workers automatically.
                </span>
                {execution.form.settings ? (
                  <span className="app-settings-field-help">
                    {execution.form.useDefault ? 'Using deployment default' : 'Custom limit'}
                    {execution.form.settings.deploymentDefault !== null
                      ? `; deployment default: ${execution.form.settings.deploymentDefault}.`
                      : '.'}
                    {!execution.form.settings.editable
                      ? ' Live enforced limits are unavailable in this deployment.'
                      : ''}
                  </span>
                ) : null}
              </label>
              <Button
                appearance="subtle"
                isDisabled={execution.controlsDisabled || execution.form.useDefault}
                onClick={execution.useDefault}
              >
                Use deployment default
              </Button>
              <SettingsActions
                changed={execution.changed}
                disabled={execution.controlsDisabled}
                saveDisabled={!execution.valid}
                loading={execution.saving}
                error={
                  execution.error ||
                  (execution.changed && !execution.valid ? 'Enter an integer from 1 to 10000.' : null)
                }
                pending={execution.loading ? 'Loading execution settings...' : undefined}
                saved={execution.saved}
                savedMessage="Saved. Workers synchronize automatically; running work is preserved."
                onSave={execution.save}
                onRevert={() => execution.resetForm()}
              />
            </section>
          ) : null}

          {status.topology === 'replicated' ? (
            status.replicaReadiness ? (
              <DeploymentReplicaReadinessPanel
                readiness={status.replicaReadiness}
                nowMs={nowMs}
                clearingStaleReplicas={clearingStaleReplicas}
                onClearStaleReplicas={() => void clearStaleReplicas()}
              />
            ) : (
              <section
                className="app-settings-section deployment-status-section"
                aria-label="Code runtime synchronization"
              >
                <div className="app-settings-section-title">Code runtime synchronization</div>
                <div className="deployment-status-empty-card">
                  No replica synchronization reports are available yet. This can happen while a managed deployment is
                  starting or if Code-runtime replica reporting is not configured.
                </div>
              </section>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
