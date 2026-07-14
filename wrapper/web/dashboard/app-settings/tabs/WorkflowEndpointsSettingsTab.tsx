import TextField from '@atlaskit/textfield';

import { BooleanSetting, SettingsActions } from '../SettingsControls';
import type { usePublicRoutesForm } from '../usePublicRoutesForm';
import type { useRuntimeLimitsForm } from '../useRuntimeLimitsForm';
import type { useWorkflowEndpointAuthForm } from '../useWorkflowEndpointAuthForm';

export function WorkflowEndpointsSettingsTab({
  auth,
  limits,
  routes,
}: {
  auth: ReturnType<typeof useWorkflowEndpointAuthForm>;
  limits: ReturnType<typeof useRuntimeLimitsForm>;
  routes: ReturnType<typeof usePublicRoutesForm>;
}) {
  const showRouteStatus = routes.status === 'workflow-endpoints';
  const showLimitStatus = limits.status === 'proxy-timeout' || limits.status === null;

  return (
    <div className="project-settings-tab-panel app-settings-workflow-endpoints-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Workflow endpoint routes">
        <div className="app-settings-section-title">Routes</div>
        <div className="app-settings-field-grid" aria-busy={routes.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Published workflow endpoint URL slug</span>
            <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
              <span className="project-settings-url-prefix">/</span>
              <TextField aria-label="Published workflow endpoint URL slug" className="project-settings-input text-field-size-l" value={routes.form.publishedWorkflowsSlug} isDisabled={routes.controlsDisabled} placeholder="workflows" onChange={(event) => {
                const value = event.currentTarget.value;
                routes.setForm((form) => ({ ...form, publishedWorkflowsSlug: value }));
                routes.clearFeedback();
              }} />
            </div>
            <span className="app-settings-field-help">Published workflow endpoints open from this top-level URL slug.</span>
          </label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Latest saved workflow endpoint URL slug</span>
            <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
              <span className="project-settings-url-prefix">/</span>
              <TextField aria-label="Latest saved workflow endpoint URL slug" className="project-settings-input text-field-size-l" value={routes.form.latestWorkflowsSlug} isDisabled={routes.controlsDisabled} placeholder="workflows-latest" onChange={(event) => {
                const value = event.currentTarget.value;
                routes.setForm((form) => ({ ...form, latestWorkflowsSlug: value }));
                routes.clearFeedback();
              }} />
            </div>
            <span className="app-settings-field-help">Latest saved draft workflow endpoints open from this top-level URL slug.</span>
          </label>
        </div>
        <SettingsActions
          changed={routes.changed.workflowEndpoints}
          disabled={routes.controlsDisabled}
          error={showRouteStatus ? routes.error : null}
          loading={routes.saving || routes.applying}
          onRevert={() => routes.revert('workflow-endpoints')}
          onSave={() => routes.save('workflow-endpoints')}
          pending={showRouteStatus && routes.applying ? 'Applying routes...' : undefined}
          saved={showRouteStatus && routes.saved}
        />
      </section>

      <section className="app-settings-section" aria-label="Workflow endpoint access control">
        <div className="app-settings-section-title">Access control</div>
        <div className="app-settings-field-grid" aria-busy={auth.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Bearer token requirement</span>
            <BooleanSetting
              checked={auth.form.requireBearerAuth}
              disabled={auth.controlsDisabled}
              label="Require Authorization: Bearer <Rivet key> for workflow endpoint calls"
              onChange={(requireBearerAuth) => {
                auth.setForm({ requireBearerAuth });
                auth.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">Keep this enabled unless workflow endpoints are protected by another trusted access layer.</span>
          </label>
        </div>
        <SettingsActions changed={auth.changed} disabled={auth.controlsDisabled} error={auth.error} loading={auth.saving} onRevert={auth.revert} onSave={auth.save} saved={auth.saved} />
      </section>

      <section className="app-settings-section" aria-label="HTTP request timeout">
        <div className="app-settings-section-title">HTTP request timeout</div>
        <div className="app-settings-field-grid" aria-busy={limits.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Proxy read timeout</span>
            <TextField aria-label="Proxy read timeout in seconds" type="number" min={1} value={limits.form.proxyReadTimeoutSeconds} isDisabled={limits.controlsDisabled} elemAfterInput={<span className="app-settings-input-suffix">seconds</span>} onChange={(event) => {
              const value = event.currentTarget.value;
              limits.setForm((form) => ({ ...form, proxyReadTimeoutSeconds: value }));
              limits.clearFeedback();
            }} />
            <span className="app-settings-field-help">How long standard API, workflow endpoint, and web-app action requests may stay open through nginx. Websocket routes stay long-lived separately.</span>
          </label>
        </div>
        <SettingsActions
          changed={limits.changed.proxyTimeout}
          disabled={limits.controlsDisabled}
          error={showLimitStatus ? limits.error : null}
          loading={limits.saving && limits.status === 'proxy-timeout'}
          onRevert={() => limits.revert('proxy-timeout')}
          onSave={() => limits.save('proxy-timeout')}
          saved={showLimitStatus && limits.saved}
        />
      </section>
    </div>
  );
}
