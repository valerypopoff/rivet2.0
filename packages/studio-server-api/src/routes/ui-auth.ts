import { Router, type Request, type Response } from 'express';

import { getExpectedUiSessionToken, isTrustedProxyRequest, isValidSharedKey } from '../auth.js';
import {
  SERVER_UI_OAUTH_SESSION_COOKIE_NAME,
  SERVER_UI_OAUTH_STATE_COOKIE_NAME,
  addServerUiOAuthError,
  clearCookie,
  completeServerUiOAuthCallback,
  createCookie,
  createDummyOAuthCode,
  createServerUiOAuthAuthorizationRedirect,
  getServerUiAuthErrorMessage,
  getServerUiAuthMode,
  getServerUiOAuthDummyEmail,
  getServerUiOAuthCallbackFailureCode,
  getServerUiOAuthStartPath,
  isDummyOAuthAllowedForRequest,
  isServerUiAuthRequestAllowed,
  readServerUiOAuthState,
  shouldRedirectServerUiOAuthCallbackFailure,
} from '../server-ui-auth.js';
import {
  addUiAuthErrorToReturnTo,
  removeUiAuthErrorFromReturnTo,
  sanitizeUiAuthReturnTo,
} from '../ui-auth-utils.js';
import { createHttpError } from '../utils/httpError.js';

export const uiAuthRouter = Router();
const defaultUiReturnTo = '/';

function isFormPost(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');
}

function setNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

function getRequestReturnTo(req: Request): string {
  return sanitizeUiAuthReturnTo(
    req.get('x-rivet-ui-return-to') ??
    req.query.return_to ??
    req.body?.return_to,
  );
}

function redirectFormError(res: Response, returnTo: string, authError: string): void {
  res.redirect(303, addUiAuthErrorToReturnTo(returnTo, authError));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getAuthErrorFromReturnTo(returnTo: string): string {
  try {
    return new URL(returnTo, 'http://rivet.local').searchParams.get('auth_error') ?? '';
  } catch {
    return '';
  }
}

function renderAuthShell(options: {
  title: string;
  message: string;
  bodyHtml: string;
  hint?: string;
  error?: string;
}): string {
  const errorHtml = options.error
    ? `<div class="error" role="alert">${escapeHtml(options.error)}</div>`
    : '<div class="error" aria-live="polite"></div>';

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
      button, .button-link { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; box-sizing: border-box; border: none; border-radius: 12px; background: #f3f4f6; color: #111827; padding: 0 16px; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; }
      .error { min-height: 20px; margin: 0 0 10px; font-size: 14px; color: #fca5a5; }
      .hint { margin-top: 12px; font-size: 13px; color: rgba(243, 244, 246, 0.52); }
    </style>
  </head>
  <body>
    <div class="overlay" aria-hidden="true"></div>
    <main class="modal" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h1 id="gate-title">${escapeHtml(options.title)}</h1>
      <p>${escapeHtml(options.message)}</p>
      ${errorHtml}
      ${options.bodyHtml}
      ${options.hint ? `<div class="hint">${escapeHtml(options.hint)}</div>` : ''}
    </main>
  </body>
</html>`;
}

function renderKeyPrompt(returnTo: string): string {
  const retryReturnTo = removeUiAuthErrorFromReturnTo(returnTo);
  return renderAuthShell({
    title: 'Enter Access Key',
    message: 'Provide the Rivet key to open this host in the browser.',
    error: getServerUiAuthErrorMessage(getAuthErrorFromReturnTo(returnTo)),
    bodyHtml: `<form id="gate-form" method="post" action="/__rivet_auth">
        <label for="gate-username" class="sr-only">Username</label>
        <input id="gate-username" class="sr-only" name="username" type="text" value="Rivet" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        <label for="gate-key">Access key</label>
        <input id="gate-key" name="key" type="password" autocomplete="current-password" autofocus required>
        <input name="return_to" type="hidden" value="${escapeHtml(retryReturnTo)}">
        <button type="submit">Continue</button>
      </form>`,
    hint: 'Trusted hosts still bypass this prompt automatically.',
  });
}

function renderOAuthPrompt(returnTo: string): string {
  const authError = getServerUiAuthErrorMessage(getAuthErrorFromReturnTo(returnTo));
  const retryReturnTo = removeUiAuthErrorFromReturnTo(returnTo);
  return renderAuthShell({
    title: authError ? 'Sign in failed' : 'Sign in required',
    message: authError ? 'Rivet could not complete the OAuth sign-in.' : 'Sign in to open the Rivet server UI.',
    error: authError,
    bodyHtml: `<a class="button-link" href="${escapeHtml(getServerUiOAuthStartPath(retryReturnTo))}">Sign in</a>`,
    hint: 'Only emails listed in Settings -> Server UI access -> Server UI admin emails can open the server UI.',
  });
}

function renderOpenPrompt(returnTo: string): string {
  const retryReturnTo = removeUiAuthErrorFromReturnTo(returnTo);
  return renderAuthShell({
    title: 'Rivet is open',
    message: 'This server UI is not gated.',
    bodyHtml: `<a class="button-link" href="${escapeHtml(retryReturnTo)}">Continue</a>`,
  });
}

function renderDummyOAuthPage(state: string): string {
  const email = getServerUiOAuthDummyEmail();
  return renderAuthShell({
    title: 'Dummy OAuth sign in',
    message: 'This local-only provider creates a normal Rivet server UI OAuth session for testing admin email allowlists.',
    bodyHtml: `<form method="post" action="/__rivet_auth/oauth/dummy">
        <input type="hidden" name="state" value="${escapeHtml(state)}">
        <label for="dummy-email">Email</label>
        <input id="dummy-email" name="email" type="email" value="${escapeHtml(email)}" autocomplete="email" required autofocus>
        <button type="submit">Continue</button>
      </form>`,
  });
}

uiAuthRouter.get('/ui-auth/check', (req, res) => {
  setNoStoreHeaders(res);
  if (!isTrustedProxyRequest(req)) {
    res.status(403).end();
    return;
  }

  res.status(isServerUiAuthRequestAllowed(req) ? 204 : 401).end();
});

uiAuthRouter.get('/ui-auth/prompt', (req, res, next) => {
  try {
    setNoStoreHeaders(res);
    if (!isTrustedProxyRequest(req)) {
      next(createHttpError(403, 'Forbidden'));
      return;
    }

    const returnTo = getRequestReturnTo(req);
    const mode = getServerUiAuthMode();
    const html = mode === 'oauth'
      ? renderOAuthPrompt(returnTo)
      : mode === 'key'
        ? renderKeyPrompt(returnTo)
        : renderOpenPrompt(returnTo);
    res.status(200).type('html').send(html);
  } catch (error) {
    next(error);
  }
});

uiAuthRouter.post('/ui-auth', (req, res, next) => {
  const formPost = isFormPost(req.get('content-type'));
  const formReturnTo = getRequestReturnTo(req);
  setNoStoreHeaders(res);

  if (!isTrustedProxyRequest(req)) {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'forbidden');
      return;
    }
    next(createHttpError(403, 'Forbidden'));
    return;
  }

  if (getServerUiAuthMode() !== 'key') {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'unavailable');
      return;
    }
    next(createHttpError(403, 'Rivet key login is not enabled for the server UI'));
    return;
  }

  const configuredKey = process.env.RIVET_KEY?.trim();
  if (!configuredKey) {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'unavailable');
      return;
    }
    next(createHttpError(500, 'UI access key is not configured'));
    return;
  }

  const providedKey = typeof req.body?.key === 'string'
    ? req.body.key
    : typeof req.body?.token === 'string'
      ? req.body.token
      : '';
  if (!isValidSharedKey(providedKey)) {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'invalid');
      return;
    }
    next(createHttpError(401, 'Invalid access key'));
    return;
  }

  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0]?.trim().toLowerCase() || req.protocol || 'http';
  const secureSuffix = protocol === 'https' ? '; Secure' : '';
  const sessionToken = getExpectedUiSessionToken();

  res.setHeader('Set-Cookie', `rivet_ui_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secureSuffix}`);
  if (formPost) {
    res.redirect(303, formReturnTo);
    return;
  }

  res.status(204).end();
});

uiAuthRouter.get('/ui-auth/oauth/start', (req, res, next) => {
  try {
    setNoStoreHeaders(res);
    if (!isTrustedProxyRequest(req)) {
      next(createHttpError(403, 'Forbidden'));
      return;
    }

    const redirect = createServerUiOAuthAuthorizationRedirect(req, getRequestReturnTo(req));
    res.setHeader('Set-Cookie', redirect.cookies);
    res.redirect(302, redirect.location);
  } catch (error) {
    next(error);
  }
});

uiAuthRouter.get('/ui-auth/oauth/dummy', (req, res) => {
  setNoStoreHeaders(res);
  if (!isTrustedProxyRequest(req)) {
    res.status(403).type('html').send(renderAuthShell({
      title: 'Forbidden',
      message: 'This sign-in route is only available through the trusted Rivet proxy.',
      bodyHtml: '',
    }));
    return;
  }

  if (!isDummyOAuthAllowedForRequest(req)) {
    res.status(403).type('html').send(renderAuthShell({
      title: 'Forbidden',
      message: 'Dummy OAuth is only available for localhost requests.',
      bodyHtml: '',
    }));
    return;
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  res.status(200).type('html').send(renderDummyOAuthPage(state));
});

uiAuthRouter.post('/ui-auth/oauth/dummy', (req, res) => {
  setNoStoreHeaders(res);
  if (!isTrustedProxyRequest(req)) {
    res.status(403).type('html').send(renderAuthShell({
      title: 'Forbidden',
      message: 'This sign-in route is only available through the trusted Rivet proxy.',
      bodyHtml: '',
    }));
    return;
  }

  if (!isDummyOAuthAllowedForRequest(req)) {
    res.status(403).type('html').send(renderAuthShell({
      title: 'Forbidden',
      message: 'Dummy OAuth is only available for localhost requests.',
      bodyHtml: '',
    }));
    return;
  }

  const state = typeof req.body?.state === 'string' ? req.body.state : '';
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const callbackUrl = new URL('/__rivet_auth/oauth/callback', 'http://rivet.local');
  callbackUrl.searchParams.set('code', createDummyOAuthCode(email));
  callbackUrl.searchParams.set('state', state);
  res.redirect(303, `${callbackUrl.pathname}${callbackUrl.search}`);
});

uiAuthRouter.get('/ui-auth/oauth/callback', async (req, res, next) => {
  try {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    setNoStoreHeaders(res);
    res.setHeader('Set-Cookie', clearCookie(SERVER_UI_OAUTH_STATE_COOKIE_NAME, req));
    if (!isTrustedProxyRequest(req)) {
      next(createHttpError(403, 'Forbidden'));
      return;
    }

    const statePayload = state ? readServerUiOAuthState(req, state) : null;
    const returnTo = sanitizeUiAuthReturnTo(statePayload?.returnTo);

    if (typeof req.query.error === 'string') {
      res.redirect(303, addServerUiOAuthError(returnTo, 'oauth_denied'));
      return;
    }

    if (!statePayload || !code) {
      res.redirect(303, addServerUiOAuthError(returnTo, 'oauth_state'));
      return;
    }

    let sessionCookie: string;
    try {
      sessionCookie = await completeServerUiOAuthCallback(req, code);
    } catch (error) {
      if (!shouldRedirectServerUiOAuthCallbackFailure(error)) {
        throw error;
      }

      res.redirect(303, addServerUiOAuthError(returnTo, getServerUiOAuthCallbackFailureCode(error)));
      return;
    }

    res.setHeader('Set-Cookie', [
      clearCookie(SERVER_UI_OAUTH_STATE_COOKIE_NAME, req),
      sessionCookie,
    ]);
    res.redirect(303, returnTo);
  } catch (error) {
    next(error);
  }
});

uiAuthRouter.get('/ui-auth/logout', (req, res) => {
  const returnTo = sanitizeUiAuthReturnTo(req.query.return_to);
  setNoStoreHeaders(res);
  if (!isTrustedProxyRequest(req)) {
    res.status(403).end();
    return;
  }

  res.setHeader('Set-Cookie', [
    clearCookie(SERVER_UI_OAUTH_STATE_COOKIE_NAME, req),
    clearCookie(SERVER_UI_OAUTH_SESSION_COOKIE_NAME, req),
    createCookie('rivet_ui_token', '', req, 0),
  ]);
  res.redirect(303, returnTo || defaultUiReturnTo);
});

export {
  addUiAuthErrorToReturnTo,
  removeUiAuthErrorFromReturnTo,
  sanitizeUiAuthReturnTo,
};
