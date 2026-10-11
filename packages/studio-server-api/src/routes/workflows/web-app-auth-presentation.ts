import { type Request } from 'express';
import { getPublishedWebAppsBasePath } from '../../workflowEndpointPaths.js';
import { getWebAppAuthMode } from '../../web-app-oauth.js';
import { sanitizeUiAuthReturnTo } from '../../ui-auth-utils.js';

export const WEB_APP_OAUTH_AUTH_ACTION_QUERY = 'auth_action';

export const WEB_APP_OAUTH_LOGIN_ACTION = 'login';

export const WEB_APP_OAUTH_PROMPT_QUERY = 'auth_prompt';

export function getWebAppRequestReturnTo(req: Request): string {
  return req.originalUrl || req.url || '/';
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function getWebAppAuthRetryPath(req: Request): string {
  const parsed = new URL(getWebAppRequestReturnTo(req), 'http://rivet.local');
  parsed.searchParams.delete('auth_error');
  parsed.searchParams.delete(WEB_APP_OAUTH_AUTH_ACTION_QUERY);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

export function getWebAppCleanReturnTo(req: Request): string {
  const parsed = new URL(getWebAppAuthRetryPath(req), 'http://rivet.local');
  parsed.searchParams.delete(WEB_APP_OAUTH_PROMPT_QUERY);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

export function getWebAppOAuthLoginPath(req: Request): string {
  const parsed = new URL(getWebAppAuthRetryPath(req), 'http://rivet.local');
  parsed.searchParams.set(WEB_APP_OAUTH_AUTH_ACTION_QUERY, WEB_APP_OAUTH_LOGIN_ACTION);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
}

export function getWebAppOAuthLogoutPath(
  returnTo: string,
  options: {
    selectAccount?: boolean;
  } = {},
): string {
  const params = new URLSearchParams({ return_to: returnTo });
  if (options.selectAccount) {
    params.set('select_account', '1');
  }
  return `${getPublishedWebAppsBasePath()}/auth/logout?${params.toString()}`;
}

export function getWebAppCurrentLogoutPath(req: Request): string {
  return getWebAppOAuthLogoutPath(getWebAppCleanReturnTo(req), { selectAccount: true });
}

export function getWebAppAuthErrorMessage(errorCode: string): string {
  if (errorCode === 'oauth_profile') {
    return 'OAuth sign-in succeeded, but the profile response did not include the configured email claim.';
  }

  if (errorCode === 'oauth_token') {
    return 'OAuth sign-in could not exchange the authorization code for an access token.';
  }

  if (errorCode === 'oauth_state') {
    return 'The OAuth sign-in session expired. Try signing in again.';
  }

  if (errorCode === 'oauth_denied') {
    return 'The OAuth provider rejected the sign-in request.';
  }

  return 'OAuth sign-in failed. Try signing in again.';
}

export function renderWebAppAuthStatusHtml(options: {
  title: string;
  message: string;
  code?: string;
  primaryHref: string;
  primaryLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}): string {
  const secondaryLink =
    options.secondaryHref && options.secondaryLabel
      ? `<a class="secondary" href="${escapeHtml(options.secondaryHref)}">${escapeHtml(options.secondaryLabel)}</a>`
      : '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #101114; color: #f4f4f5; }
  main { width: min(440px, calc(100vw - 32px)); border: 1px solid #333741; border-radius: 8px; background: #1d1f24; padding: 24px; box-shadow: 0 24px 80px rgb(0 0 0 / 0.38); }
  h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.2; }
  p { margin: 0 0 18px; color: #c8c8cf; line-height: 1.5; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  a { display: inline-flex; align-items: center; min-height: 34px; padding: 0 13px; border-radius: 6px; background: #2f6fed; color: white; font-weight: 650; text-decoration: none; }
  a.secondary { background: transparent; color: #d6d8df; border: 1px solid #3d414b; }
  code { color: #d6d8df; }
</style>
<main>
  <h1>${escapeHtml(options.title)}</h1>
  <p>${escapeHtml(options.message)}</p>
  ${options.code ? `<p>Error code: <code>${escapeHtml(options.code)}</code></p>` : ''}
  <div class="actions">
    <a href="${escapeHtml(options.primaryHref)}">${escapeHtml(options.primaryLabel)}</a>
    ${secondaryLink}
  </div>
</main>`;
}

export function renderWebAppAuthErrorHtml(errorCode: string, retryPath: string, logoutPath: string): string {
  return renderWebAppAuthStatusHtml({
    title: 'Web app sign-in failed',
    message: getWebAppAuthErrorMessage(errorCode),
    code: errorCode || 'oauth_failed',
    primaryHref: retryPath,
    primaryLabel: 'Try again',
    secondaryHref: logoutPath,
    secondaryLabel: 'Sign out',
  });
}

export function renderWebAppLoginRequiredHtml(req: Request): string {
  return renderWebAppAuthStatusHtml({
    title: 'Sign in required',
    message: 'Sign in to open this Rivet web app.',
    primaryHref: getWebAppOAuthLoginPath(req),
    primaryLabel: 'Sign in',
  });
}

export function renderWebAppUiGatePromptHtml(req: Request): string {
  const returnTo = escapeHtml(sanitizeUiAuthReturnTo(getWebAppRequestReturnTo(req)));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Rivet Access</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, rgba(96, 165, 250, 0.18), transparent 34%), linear-gradient(180deg, #121419 0%, #0b0d11 100%); font-family: Georgia, "Times New Roman", serif; color: #f3f4f6; }
      .overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(10px); }
      .modal { position: relative; width: min(440px, calc(100vw - 32px)); padding: 28px; border-radius: 18px; background: rgba(18, 20, 25, 0.94); border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42); }
      h1 { margin: 0 0 10px; font-size: 31px; line-height: 1.05; }
      p { margin: 0 0 18px; font-size: 16px; line-height: 1.55; color: rgba(243, 244, 246, 0.78); }
      form { display: grid; gap: 12px; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      label { font-size: 14px; color: rgba(243, 244, 246, 0.84); }
      input { width: 100%; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; background: rgba(255, 255, 255, 0.04); color: inherit; padding: 12px 14px; font: inherit; }
      input:focus { outline: 2px solid rgba(96, 165, 250, 0.75); outline-offset: 2px; }
      button { border: none; border-radius: 12px; background: #f3f4f6; color: #111827; padding: 12px 16px; font: inherit; font-weight: 700; cursor: pointer; }
      .hint { margin-top: 12px; font-size: 13px; color: rgba(243, 244, 246, 0.52); }
    </style>
  </head>
  <body>
    <div class="overlay" aria-hidden="true"></div>
    <main class="modal" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h1 id="gate-title">Enter Access Key</h1>
      <p>Provide the Rivet key to open this web app.</p>
      <form method="post" action="/__rivet_auth">
        <label for="gate-username" class="sr-only">Username</label>
        <input id="gate-username" class="sr-only" name="username" type="text" value="Rivet" autocomplete="username" required>
        <label for="gate-key">Access key</label>
        <input id="gate-key" name="key" type="password" autocomplete="current-password" autofocus required>
        <input name="return_to" type="hidden" value="${returnTo}">
        <button type="submit">Continue</button>
      </form>
      <div class="hint">Token-free hosts still bypass this prompt automatically.</div>
    </main>
  </body>
</html>`;
}

export function renderWebAppAccessDeniedHtml(email: string, logoutPath: string): string {
  return renderWebAppAuthStatusHtml({
    title: 'Web app access denied',
    message: `You are signed in as ${email}, but this web app does not allow that email.`,
    code: 'oauth_forbidden',
    primaryHref: logoutPath,
    primaryLabel: 'Sign out and choose another account',
  });
}

export function renderWebAppOriginDeniedHtml(req: Request): string {
  const options = {
    title: 'Web app request blocked',
    message: 'The request did not come from the expected Rivet server origin.',
    code: 'origin_forbidden',
    primaryHref: getWebAppAuthRetryPath(req),
    primaryLabel: 'Try again',
  };

  return getWebAppAuthMode() === 'oauth'
    ? renderWebAppAuthStatusHtml({
        ...options,
        secondaryHref: getWebAppCurrentLogoutPath(req),
        secondaryLabel: 'Sign out',
      })
    : renderWebAppAuthStatusHtml(options);
}
