import type { useTrustedHostsForm } from '../useTrustedHostsForm';

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

export function GeneralSettingsTab({
  trustedHosts,
}: {
  trustedHosts: ReturnType<typeof useTrustedHostsForm>;
}) {
  return (
    <div className="project-settings-tab-panel app-settings-general-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Application">
        <div className="app-settings-section-title">Application</div>
        <div className="about-detail-row"><span className="about-detail-label">Name</span><span className="about-detail-value">{appName}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Version</span><span className="about-detail-value">{appVersion}</span></div>
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
      </section>

    </div>
  );
}
