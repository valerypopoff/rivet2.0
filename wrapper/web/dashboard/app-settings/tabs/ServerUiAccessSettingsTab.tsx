import { SettingsActions } from '../SettingsControls';
import type { useWebAppAuthForm } from '../useWebAppAuthForm';

export function ServerUiAccessSettingsTab({ auth }: { auth: ReturnType<typeof useWebAppAuthForm> }) {
  const showStatus = auth.status === 'server-ui-access';
  return (
    <div className="project-settings-tab-panel app-settings-server-ui-access-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Server UI access">
        <div className="app-settings-field-grid" aria-busy={auth.controlsDisabled}>
          <div className="app-settings-field">
            <span className="app-settings-field-label">Access mode</span>
            <span className="app-settings-field-help">
              The editor and dashboard gate is selected by <code>RIVET_SERVER_UI_AUTH_MODE</code> in <code>.env</code>{' '}
              or deployment env. Use <code>none</code>, <code>key</code>, or <code>oauth</code>, then restart or roll out
              the API so it reads the new mode.
            </span>
          </div>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Server UI admin emails</span>
            <textarea
              aria-label="Server UI admin emails"
              className="project-settings-textarea app-settings-trusted-hosts"
              value={auth.form.serverUiAdminEmailsText}
              disabled={auth.controlsDisabled}
              placeholder="admin@example.com"
              onChange={(event) => {
                const value = event.currentTarget.value;
                auth.setForm((form) => ({ ...form, serverUiAdminEmailsText: value }));
                auth.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">
              One email per line. When <code>RIVET_SERVER_UI_AUTH_MODE=oauth</code>, only these users can open the
              editor and dashboard. OAuth provider and session settings live in the OAuth tab.
            </span>
          </label>
        </div>
        <SettingsActions
          changed={auth.changed.serverUiAccess}
          disabled={auth.controlsDisabled}
          error={showStatus ? auth.error : null}
          loading={auth.saving && showStatus}
          onRevert={() => auth.revert('server-ui-access')}
          onSave={() => auth.save('server-ui-access')}
          saved={showStatus && auth.saved}
        />
      </section>
    </div>
  );
}
