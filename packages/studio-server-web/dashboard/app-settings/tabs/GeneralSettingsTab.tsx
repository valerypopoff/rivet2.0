import type { useTrustedClientsForm } from '../useTrustedClientsForm';

const appVersion = import.meta.env.VITE_APP_VERSION || 'unknown';
const appName = 'Rivet Studio Server';

export function GeneralSettingsTab({
  trustedClients,
}: {
  trustedClients: ReturnType<typeof useTrustedClientsForm>;
}) {
  return (
    <div className="project-settings-tab-panel app-settings-general-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Application">
        <div className="app-settings-section-title">Application</div>
        <div className="about-detail-row"><span className="about-detail-label">Name</span><span className="about-detail-value">{appName}</span></div>
        <div className="about-detail-row"><span className="about-detail-label">Version</span><span className="about-detail-value">{appVersion}</span></div>
      </section>

      <section className="app-settings-section" aria-label="Trusted client settings">
        <div className="app-settings-section-title">Trusted clients</div>
        <div className="app-settings-field-grid" aria-busy={trustedClients.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Client IP addresses or networks</span>
            <textarea
              aria-label="Trusted clients"
              className="project-settings-textarea app-settings-trusted-clients"
              value={trustedClients.form.trustedClientsText}
              disabled={trustedClients.controlsDisabled}
              placeholder={'192.0.2.15\n10.20.0.0/16'}
              onChange={(event) => {
                const value = event.currentTarget.value;
                trustedClients.setForm((form) => ({ ...form, trustedClientsText: value }));
                trustedClients.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">
              Client IP addresses or CIDR networks, one per line or comma-separated. These clients bypass the server UI gate,
              web-app auth, and workflow endpoint bearer checks, including administrator access. Enter client addresses,
              not the server address. Everyone sharing an allowed VPN or office address is trusted.
            </span>
            <span className="app-settings-field-help">
              Verified address for this connection: {trustedClients.clientAddress ?? 'Unavailable — trusted access cannot be determined for this connection.'}
            </span>
            {trustedClients.form.policyError && <p role="alert">{trustedClients.form.policyError}</p>}
            {!!trustedClients.form.legacyTrustedHosts?.length && (
              <span className="app-settings-field-help" role="status">
                Hostname-only access has been disabled. Previous entries: {trustedClients.form.legacyTrustedHosts.join(', ')}.
                Configure client IP addresses or networks to restore intentional internal access; normal authentication remains available.
              </span>
            )}
          </label>
        </div>
      </section>

    </div>
  );
}
