import TextField from '@atlaskit/textfield';

import type { HostedRouteConfig } from '../../types';
import { defaultSessionTtlHours, type WebAppAuthSettingsForm } from '../model';
import { BooleanSetting, ModeButton, ModeGroup, SettingsActions } from '../SettingsControls';
import type { useWebAppAuthForm } from '../useWebAppAuthForm';

export function OAuthSettingsTab({ auth, routeConfig }: {
  auth: ReturnType<typeof useWebAppAuthForm>;
  routeConfig: HostedRouteConfig;
}) {
  const form = auth.form;
  const showStatus = auth.status === 'oauth';
  const update = <K extends keyof WebAppAuthSettingsForm>(key: K, value: WebAppAuthSettingsForm[K]) => {
    auth.setForm((current) => ({ ...current, [key]: value }));
    auth.clearFeedback();
  };

  return (
    <div className="project-settings-tab-panel app-settings-oauth-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="OAuth provider settings">
        <div className="app-settings-section-title">Provider</div>
        <div className="app-settings-field-grid" aria-busy={auth.controlsDisabled}>
          <div className="app-settings-field">
            <span className="app-settings-field-label">Shared setup</span>
            <span className="app-settings-field-help">These settings are used by web apps in OAuth mode and by the server UI when RIVET_SERVER_UI_AUTH_MODE is set to oauth.</span>
          </div>
          <div className="app-settings-field">
            <span className="app-settings-field-label">Provider type</span>
            <ModeGroup label="OAuth provider">
              <ModeButton active={form.provider === 'external'} disabled={auth.controlsDisabled} onClick={() => update('provider', 'external')}>External provider</ModeButton>
              <ModeButton active={form.provider === 'dummy'} disabled={auth.controlsDisabled} onClick={() => update('provider', 'dummy')}>Local dummy</ModeButton>
            </ModeGroup>
            <span className="app-settings-field-help">{form.provider === 'dummy' ? 'Use a local test sign-in page instead of leaving localhost for a real provider.' : 'Use a real OAuth provider for public or shared deployments.'}</span>
          </div>

          {form.provider === 'dummy' ? (
            <>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Default test email</span>
                <TextField aria-label="Default test email" value={form.dummyEmail} isDisabled={auth.controlsDisabled} placeholder="local@example.test" onChange={(event) => update('dummyEmail', event.currentTarget.value)} />
                <span className="app-settings-field-help">The dummy sign-in form is prefilled with this email for local testing.</span>
              </label>
              <div className="app-settings-field">
                <BooleanSetting checked={form.dummyAllowNonLocalhost} disabled={auth.controlsDisabled} label="Allow dummy sign-in outside localhost" onChange={(value) => update('dummyAllowNonLocalhost', value)} />
                <span className="app-settings-field-help">Keep this off for shared environments. It exists only for local integration testing.</span>
              </div>
            </>
          ) : (
            <>
              <label className="app-settings-field"><span className="app-settings-field-label">Authorization URL</span><TextField aria-label="Authorization URL" value={form.authorizeUrl} isDisabled={auth.controlsDisabled} placeholder="https://identity.example.com/oauth/authorize" onChange={(event) => update('authorizeUrl', event.currentTarget.value)} /></label>
              <label className="app-settings-field"><span className="app-settings-field-label">Token URL</span><TextField aria-label="Token URL" value={form.tokenUrl} isDisabled={auth.controlsDisabled} placeholder="https://identity.example.com/oauth/token" onChange={(event) => update('tokenUrl', event.currentTarget.value)} /></label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Profile URL</span>
                <TextField aria-label="Profile URL" value={form.userUrl} isDisabled={auth.controlsDisabled} placeholder="https://identity.example.com/api/profile" onChange={(event) => update('userUrl', event.currentTarget.value)} />
                <span className="app-settings-field-help">The profile response must contain the visitor email.</span>
              </label>
              <label className="app-settings-field"><span className="app-settings-field-label">Client ID</span><TextField aria-label="Client ID" value={form.clientId} isDisabled={auth.controlsDisabled} onChange={(event) => update('clientId', event.currentTarget.value)} /></label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Client secret</span>
                <TextField aria-label="Client secret" type="password" value={form.clientSecret} isDisabled={auth.controlsDisabled} placeholder={form.clientSecretConfigured ? 'Already saved; leave blank to keep it' : ''} onChange={(event) => update('clientSecret', event.currentTarget.value)} />
                <span className="app-settings-field-help">{form.clientSecretConfigured ? 'A client secret is saved. Enter a new value only when rotating it.' : 'Required before OAuth web app auth can be enabled.'}</span>
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Callback URL</span>
                <TextField aria-label="Callback URL" value={form.callbackUrl} isDisabled={auth.controlsDisabled} placeholder={`${window.location.origin}${routeConfig.publishedAppsBasePath}/auth/callback`} onChange={(event) => update('callbackUrl', event.currentTarget.value)} />
                <span className="app-settings-field-help">Leave blank to derive the web-app callback from the current host and published web app route. The server UI uses {`${window.location.origin}/__rivet_auth/oauth/callback`}.</span>
              </label>
              <label className="app-settings-field"><span className="app-settings-field-label">Scopes</span><TextField aria-label="OAuth scopes" value={form.scopes} isDisabled={auth.controlsDisabled} placeholder="email" onChange={(event) => update('scopes', event.currentTarget.value)} /></label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Email claim path</span>
                <TextField aria-label="Email claim path" value={form.emailClaim} isDisabled={auth.controlsDisabled} placeholder="email" onChange={(event) => update('emailClaim', event.currentTarget.value)} />
                <span className="app-settings-field-help">Use dot paths like data.email when the provider nests the email.</span>
              </label>
              <div className="app-settings-field">
                <span className="app-settings-field-label">Token request credentials</span>
                <ModeGroup label="Token request credentials">
                  <ModeButton active={form.clientAuthMethod === 'body'} disabled={auth.controlsDisabled} onClick={() => update('clientAuthMethod', 'body')}>Request body</ModeButton>
                  <ModeButton active={form.clientAuthMethod === 'basic'} disabled={auth.controlsDisabled} onClick={() => update('clientAuthMethod', 'basic')}>HTTP Basic</ModeButton>
                </ModeGroup>
              </div>
            </>
          )}

          <label className="app-settings-field">
            <span className="app-settings-field-label">Session signing secret</span>
            <TextField aria-label="Session signing secret" type="password" value={form.sessionSecret} isDisabled={auth.controlsDisabled} placeholder={form.sessionSecretConfigured ? 'Already saved; leave blank to keep it' : ''} onChange={(event) => update('sessionSecret', event.currentTarget.value)} />
            <span className="app-settings-field-help">{form.sessionSecretConfigured ? 'A signing secret is saved. Enter a new value only when rotating it.' : form.provider === 'dummy' ? 'Required for the local dummy provider.' : 'Recommended. When blank, the OAuth client secret signs sessions.'}</span>
          </label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Keep users signed in for</span>
            <TextField aria-label="OAuth session duration in hours" type="number" min={1} value={form.sessionTtlHours} isDisabled={auth.controlsDisabled} placeholder={defaultSessionTtlHours} elemAfterInput={<span className="app-settings-input-suffix">hours</span>} onChange={(event) => update('sessionTtlHours', event.currentTarget.value)} />
          </label>
          <div className="app-settings-field">
            <BooleanSetting checked={form.debugLogProfile} disabled={auth.controlsDisabled} label="Log provider profile response for troubleshooting" onChange={(value) => update('debugLogProfile', value)} />
            <span className="app-settings-field-help">Turn this off after finding the email claim path because profile logs can contain user data.</span>
          </div>
        </div>
        <SettingsActions changed={auth.changed.oauth} disabled={auth.controlsDisabled} error={showStatus ? auth.error : null} loading={auth.saving && showStatus} onRevert={() => auth.revert('oauth')} onSave={() => auth.save('oauth')} saved={showStatus && auth.saved} />
      </section>
    </div>
  );
}
