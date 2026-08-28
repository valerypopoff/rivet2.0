import TextField from '@atlaskit/textfield';

import { ModeButton, ModeGroup } from '../SettingsControls';
import type { usePublicRoutesForm } from '../usePublicRoutesForm';
import type { useRuntimeLimitsForm } from '../useRuntimeLimitsForm';
import type { useWebAppAuthForm } from '../useWebAppAuthForm';

export function WebAppsSettingsTab({
  auth,
  limits,
  routes,
}: {
  auth: ReturnType<typeof useWebAppAuthForm>;
  limits: ReturnType<typeof useRuntimeLimitsForm>;
  routes: ReturnType<typeof usePublicRoutesForm>;
}) {
  const authHelp = auth.form.mode === 'oauth'
    ? 'Visitors sign in with the provider configured in the OAuth tab and are checked against each web app\'s allowed-email list.'
    : auth.form.mode === 'none'
      ? 'Web app routes are open at the API layer. Use this only behind another access-control layer.'
      : 'Visitors enter the Rivet key before opening web apps.';

  return (
    <div className="project-settings-tab-panel app-settings-web-apps-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Web app routes">
        <div className="app-settings-section-title">Routes</div>
        <div className="app-settings-field-grid" aria-busy={routes.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Published web app URL slug</span>
            <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
              <span className="project-settings-url-prefix">/</span>
              <TextField aria-label="Published web app URL slug" className="project-settings-input text-field-size-l" value={routes.form.publishedAppsSlug} isDisabled={routes.controlsDisabled} placeholder="apps" onChange={(event) => {
                const value = event.currentTarget.value;
                routes.setForm((form) => ({ ...form, publishedAppsSlug: value }));
                routes.clearFeedback();
              }} />
            </div>
            <span className="app-settings-field-help">Published web apps open from this top-level URL slug.</span>
          </label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Latest saved changes URL slug</span>
            <div className="project-settings-input-row project-settings-prefixed-input-row app-settings-prefixed-input-row">
              <span className="project-settings-url-prefix">/</span>
              <TextField aria-label="Latest saved changes URL slug" className="project-settings-input text-field-size-l" value={routes.form.latestAppsSlug} isDisabled={routes.controlsDisabled} placeholder="apps-latest" onChange={(event) => {
                const value = event.currentTarget.value;
                routes.setForm((form) => ({ ...form, latestAppsSlug: value }));
                routes.clearFeedback();
              }} />
            </div>
            <span className="app-settings-field-help">Latest saved draft web apps open from this top-level URL slug.</span>
          </label>
        </div>
      </section>

      <section className="app-settings-section" aria-label="Web app auth">
        <div className="app-settings-section-title">Auth</div>
        <div className="app-settings-field-grid" aria-busy={auth.controlsDisabled}>
          <div className="app-settings-field">
            <span className="app-settings-field-label">How visitors access web apps</span>
            <ModeGroup label="Web app auth mode" wide>
              <ModeButton active={auth.form.mode === 'ui-gate'} disabled={auth.controlsDisabled} onClick={() => {
                auth.setForm((form) => ({ ...form, mode: 'ui-gate' })); auth.clearFeedback();
              }}>Key</ModeButton>
              <ModeButton active={auth.form.mode === 'oauth'} disabled={auth.controlsDisabled} onClick={() => {
                auth.setForm((form) => ({ ...form, mode: 'oauth' })); auth.clearFeedback();
              }}>OAuth</ModeButton>
              <ModeButton active={auth.form.mode === 'none'} disabled={auth.controlsDisabled} onClick={() => {
                auth.setForm((form) => ({ ...form, mode: 'none' })); auth.clearFeedback();
              }}>No gate</ModeButton>
            </ModeGroup>
            <span className="app-settings-field-help">{authHelp}</span>
          </div>
        </div>
      </section>

      <section className="app-settings-section" aria-label="Web app button data">
        <div className="app-settings-section-title">Button data</div>
        <div className="app-settings-field-grid" aria-busy={limits.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Maximum data sent by web app buttons</span>
            <TextField aria-label="Maximum web app button data in MiB" type="number" min={1} value={limits.form.webAppActionRequestLimitMiB} isDisabled={limits.controlsDisabled} elemAfterInput={<span className="app-settings-input-suffix">MiB</span>} onChange={(event) => {
              const value = event.currentTarget.value;
              limits.setForm((form) => ({ ...form, webAppActionRequestLimitMiB: value }));
              limits.clearFeedback();
            }} />
            <span className="app-settings-field-help">The largest JSON payload a web app button can send when it runs a graph. This applies to both published and latest saved web apps.</span>
            <span className="app-settings-field-help">Large payloads are buffered in the API process. If another reverse proxy sits in front of Rivet, configure it to allow at least this size too.</span>
          </label>
        </div>
      </section>
    </div>
  );
}
