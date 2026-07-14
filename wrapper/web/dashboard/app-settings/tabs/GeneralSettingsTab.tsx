import TextField from '@atlaskit/textfield';

import type { HostedRouteConfig } from '../../types';
import { formatWebAppsAuthMode, parseDelimitedListText } from '../model';
import { SettingsActions } from '../SettingsControls';
import type { useRuntimeLimitsForm } from '../useRuntimeLimitsForm';
import type { useTrustedHostsForm } from '../useTrustedHostsForm';

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

export function GeneralSettingsTab({
  limits,
  routeConfig,
  trustedHosts,
}: {
  limits: ReturnType<typeof useRuntimeLimitsForm>;
  routeConfig: HostedRouteConfig;
  trustedHosts: ReturnType<typeof useTrustedHostsForm>;
}) {
  const trustedHostCount = parseDelimitedListText(trustedHosts.form.trustedHostsText).length;
  const showLimitStatus = limits.status === 'shell' || limits.status === null;

  return (
    <div className="project-settings-tab-panel app-settings-general-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Application">
        <div className="app-settings-section-title">Application</div>
        <div className="about-detail-row"><span className="about-detail-label">Name</span><span className="about-detail-value">{appName}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Version</span><span className="about-detail-value">{appVersion}</span></div>
      </section>

      <section className="app-settings-section" aria-label="Routes">
        <div className="app-settings-section-title">Routes</div>
        <div className="about-detail-row"><span className="about-detail-label">Published workflows</span><span className="about-detail-value">{routeConfig.publishedWorkflowsBasePath}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Latest workflows</span><span className="about-detail-value">{routeConfig.latestWorkflowsBasePath}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Published web apps</span><span className="about-detail-value">{routeConfig.publishedAppsBasePath}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Latest web apps</span><span className="about-detail-value">{routeConfig.latestAppsBasePath}</span></div>
      </section>

      <section className="app-settings-section" aria-label="Access">
        <div className="app-settings-section-title">Access</div>
        <div className="about-detail-row"><span className="about-detail-label">Web app auth</span><span className="about-detail-value">{formatWebAppsAuthMode(routeConfig.webAppsAuthMode)}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Trusted hosts</span><span className="about-detail-value">{trustedHostCount ? `${trustedHostCount} configured` : 'None'}</span></div>
      </section>

      <section className="app-settings-section" aria-label="Trusted host settings">
        <div className="app-settings-section-title">Trusted hosts</div>
        <div className="app-settings-field-grid" aria-busy={trustedHosts.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Hosts that bypass built-in gates</span>
            <textarea
              aria-label="Trusted hosts"
              className="project-settings-textarea app-settings-trusted-hosts"
              value={trustedHosts.form.trustedHostsText}
              disabled={trustedHosts.controlsDisabled}
              placeholder={'storyteller-rivet-1.internal.yc.prod.litnet.com\nlocalhost'}
              onChange={(event) => {
                const value = event.currentTarget.value;
                trustedHosts.setForm((form) => ({ ...form, trustedHostsText: value }));
                trustedHosts.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">
              Exact hostnames or IP addresses, one per line or comma-separated. These hosts bypass the server UI gate,
              web-app auth, and workflow endpoint bearer checks. Do not include protocol, path, wildcard, or port.
            </span>
          </label>
        </div>
        <SettingsActions
          changed={trustedHosts.changed}
          disabled={trustedHosts.controlsDisabled}
          error={trustedHosts.error}
          loading={trustedHosts.saving}
          onRevert={trustedHosts.revert}
          onSave={trustedHosts.save}
          saved={trustedHosts.saved}
        />
      </section>

      <section className="app-settings-section" aria-label="Shell execution">
        <div className="app-settings-section-title">Shell execution</div>
        <div className="app-settings-field-grid" aria-busy={limits.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Command timeout</span>
            <TextField
              aria-label="Command timeout in seconds"
              type="number"
              min={1}
              value={limits.form.commandTimeoutSeconds}
              isDisabled={limits.controlsDisabled}
              elemAfterInput={<span className="app-settings-input-suffix">seconds</span>}
              onChange={(event) => {
                const value = event.currentTarget.value;
                limits.setForm((form) => ({ ...form, commandTimeoutSeconds: value }));
                limits.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">How long hosted shell commands may run before the API stops them.</span>
          </label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Maximum captured output</span>
            <TextField
              aria-label="Maximum captured output in MiB"
              type="number"
              min={1}
              value={limits.form.maxOutputMiB}
              isDisabled={limits.controlsDisabled}
              elemAfterInput={<span className="app-settings-input-suffix">MiB</span>}
              onChange={(event) => {
                const value = event.currentTarget.value;
                limits.setForm((form) => ({ ...form, maxOutputMiB: value }));
                limits.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">How much command output the API keeps before truncating it.</span>
          </label>
        </div>
        <SettingsActions
          changed={limits.changed.shell}
          disabled={limits.controlsDisabled}
          error={showLimitStatus ? limits.error : null}
          loading={limits.saving && limits.status === 'shell'}
          onRevert={() => limits.revert('shell')}
          onSave={() => limits.save('shell')}
          saved={showLimitStatus && limits.saved}
        />
      </section>
    </div>
  );
}
