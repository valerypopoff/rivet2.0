import { useEffect, useState } from 'react';
import type { ServerUiSession } from '../../../../studio-server-shared/app-settings-types';
import { readServerUiSession } from '../../appSettingsApi';
import type { useWebAppAuthForm } from '../useWebAppAuthForm';

export function ServerUiAccessSettingsTab({ auth }: { auth: ReturnType<typeof useWebAppAuthForm> }) {
  const [session, setSession] = useState<ServerUiSession | null>(null);
  const [sessionError, setSessionError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void readServerUiSession(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSession(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSessionError(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="project-settings-tab-panel app-settings-server-ui-access-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Server UI access">
        {!session && !sessionError ? <p role="status">Checking sign-in status…</p> : null}
        {session?.mode === 'oauth' && session.email ? (
          <div className="app-settings-field">
            <span>Signed in as {session.email}</span>
            <a href="/__rivet_auth/logout?return_to=%2F">Sign out</a>
            <span className="app-settings-field-help">Signing out does not save pending settings changes.</span>
          </div>
        ) : null}
        {sessionError ? <p role="status">Could not read your sign-in status.</p> : null}
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
              className="project-settings-textarea app-settings-trusted-clients"
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
      </section>
    </div>
  );
}
