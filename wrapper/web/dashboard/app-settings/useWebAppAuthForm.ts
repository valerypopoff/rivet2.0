import type { WebAppAuthSettingsDraft } from '../../../shared/app-settings-types';
import type { HostedRouteConfig } from '../types';
import { webAppAuthSettingsResource } from '../appSettingsApi';
import {
  createWebAppAuthForm,
  defaultSessionTtlHours,
  parseDelimitedListText,
  type WebAppAuthSettingsForm,
  type WebAppAuthSettingsScope,
} from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: WebAppAuthSettingsForm = {
  mode: 'ui-gate',
  provider: 'external',
  dummyEmail: 'local@example.test',
  dummyAllowNonLocalhost: false,
  authorizeUrl: '',
  tokenUrl: '',
  userUrl: '',
  clientId: '',
  clientSecret: '',
  clientSecretConfigured: false,
  callbackUrl: '',
  scopes: 'email',
  emailClaim: 'email',
  sessionSecret: '',
  sessionSecretConfigured: false,
  sessionTtlHours: defaultSessionTtlHours,
  clientAuthMethod: 'body',
  debugLogProfile: false,
  serverUiAdminEmailsText: '',
};

function mergeSavedForm(
  saved: WebAppAuthSettingsForm,
  current: WebAppAuthSettingsForm,
  scope: WebAppAuthSettingsScope | null,
): WebAppAuthSettingsForm {
  if (scope === 'web-apps') {
    return { ...current, mode: saved.mode };
  }
  if (scope === 'server-ui-access') {
    return { ...current, serverUiAdminEmailsText: saved.serverUiAdminEmailsText };
  }
  if (scope === 'oauth') {
    return {
      ...saved,
      mode: current.mode,
      serverUiAdminEmailsText: current.serverUiAdminEmailsText,
    };
  }
  return saved;
}

export function useWebAppAuthForm(
  enabled: boolean,
  routeConfig: HostedRouteConfig,
  onRouteConfigChange?: (config: HostedRouteConfig) => void,
) {
  const resource = useSettingsFormResource({
    afterSave: (settings, scope) => {
      if (scope === 'web-apps') {
        onRouteConfigChange?.({ ...routeConfig, webAppsAuthMode: settings.mode });
      }
    },
    defaultForm,
    enabled,
    mergeSavedForm,
    resource: webAppAuthSettingsResource,
    toForm: createWebAppAuthForm,
  });
  const form = resource.form;
  const changed = {
    mode: form.mode !== resource.baseline.mode,
    oauth: (
      form.provider !== resource.baseline.provider ||
      form.dummyEmail.trim() !== resource.baseline.dummyEmail ||
      form.dummyAllowNonLocalhost !== resource.baseline.dummyAllowNonLocalhost ||
      form.authorizeUrl.trim() !== resource.baseline.authorizeUrl ||
      form.tokenUrl.trim() !== resource.baseline.tokenUrl ||
      form.userUrl.trim() !== resource.baseline.userUrl ||
      form.clientId.trim() !== resource.baseline.clientId ||
      form.clientSecret.trim() !== '' ||
      form.callbackUrl.trim() !== resource.baseline.callbackUrl ||
      form.scopes.trim() !== resource.baseline.scopes ||
      form.emailClaim.trim() !== resource.baseline.emailClaim ||
      form.sessionSecret.trim() !== '' ||
      form.sessionTtlHours.trim() !== resource.baseline.sessionTtlHours ||
      form.clientAuthMethod !== resource.baseline.clientAuthMethod ||
      form.debugLogProfile !== resource.baseline.debugLogProfile
    ),
    serverUiAccess: (
      parseDelimitedListText(form.serverUiAdminEmailsText).join('\n') !==
      resource.baseline.serverUiAdminEmailsText
    ),
  };

  const save = (scope: WebAppAuthSettingsScope) => {
    let draft: WebAppAuthSettingsDraft;
    if (scope === 'web-apps') {
      draft = { mode: form.mode };
    } else if (scope === 'server-ui-access') {
      draft = { serverUiAdminEmails: parseDelimitedListText(form.serverUiAdminEmailsText) };
    } else {
      draft = {
        provider: form.provider,
        dummyEmail: form.dummyEmail.trim(),
        dummyAllowNonLocalhost: form.dummyAllowNonLocalhost,
        authorizeUrl: form.authorizeUrl.trim(),
        tokenUrl: form.tokenUrl.trim(),
        userUrl: form.userUrl.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(),
        callbackUrl: form.callbackUrl.trim(),
        scopes: form.scopes.trim(),
        emailClaim: form.emailClaim.trim(),
        sessionSecret: form.sessionSecret.trim(),
        sessionTtlSeconds: String(Math.max(1, Number(form.sessionTtlHours.trim()) || 1) * 3600),
        clientAuthMethod: form.clientAuthMethod,
        debugLogProfile: form.debugLogProfile,
      };
    }
    return resource.save(draft, scope);
  };
  const revert = (scope: WebAppAuthSettingsScope) => {
    resource.setForm((current) => mergeSavedForm(resource.baseline, current, scope));
    resource.clearFeedback();
  };

  return {
    ...resource,
    changed,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert,
    save,
  };
}
