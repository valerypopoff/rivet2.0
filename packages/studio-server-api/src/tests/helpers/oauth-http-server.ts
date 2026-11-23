import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express, { type Request } from 'express';

import { createApiApp } from '../../app.js';
import { getExpectedProxyAuthToken } from '../../auth.js';
import { captureAppSettingsSnapshot } from '../../middleware/app-settings-snapshot.js';
import { disposeAppSettingsRepositories, runWithAppSettingsSnapshot } from '../../app-settings/settings-repository.js';
import { writeTrustedClientSettings } from '../../trusted-client-settings.js';
import { readWebAppAuthSettingsSync, writeWebAppAuthSettings } from '../../web-app-auth-settings.js';
import {
  completeServerUiOAuthCallback,
  createCookie,
  clearCookie,
  createServerUiOAuthAuthorizationRedirect,
  getServerUiOAuthSettingsVersion,
  isServerUiAuthRequestAllowed,
  readServerUiOAuthSession,
} from '../../server-ui-auth.js';
import {
  createWebAppOAuthAuthorizationRedirect,
  isWebAppOAuthSessionAllowed,
  readWebAppOAuthSession,
} from '../../web-app-oauth.js';
import { watchAuthorization } from '../../watch-authorization.js';
import { listenTestServer } from './http-server-harness.js';
import type { OAuthProviderRequest } from './oauth-http-fixture.js';

if (!process.send || !process.env.RIVET_OAUTH_TEST_ROOT) throw new Error('Owned OAuth test child required');
const root = process.env.RIVET_OAUTH_TEST_ROOT;
await fs.mkdir(path.join(root, 'app'), { recursive: true });
await writeTrustedClientSettings({ trustedClients: [] });

type Stage = 'token' | 'profile';
const requests: OAuthProviderRequest[] = [];
let behavior: {
  tokenStatus?: number;
  profileStatus?: number;
  invalidJson?: Stage;
  disconnect?: Stage;
  missingToken?: boolean;
  missingEmail?: boolean;
} = {};
let hold: { stage: Stage; entered: Promise<void>; enter(): void; released: Promise<void>; release(): void } | undefined;
let stopWatching: (() => void) | undefined;
let revocations = 0;

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function sign(value: object, secret = readWebAppAuthSettingsSync().sessionSecret): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function decode(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function providerResponse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url!, 'http://fixture');
  if (url.pathname === '/authorize') {
    res.setHeader('content-type', 'text/html');
    res.end(`<form action="/approve"><label>Email<input name="email" value="admin@example.test"></label>
      <input type="hidden" name="redirect_uri" value="${escapeHtml(url.searchParams.get('redirect_uri')!)}">
      <input type="hidden" name="state" value="${escapeHtml(url.searchParams.get('state')!)}">
      <button>Continue</button></form>`);
    return;
  }
  if (url.pathname === '/approve') {
    const target = new URL(url.searchParams.get('redirect_uri')!);
    if (target.origin !== application.baseUrl) {
      res.writeHead(400).end();
      return;
    }
    target.searchParams.set('state', url.searchParams.get('state')!);
    target.searchParams.set('code', Buffer.from(url.searchParams.get('email')!).toString('base64url'));
    res.writeHead(302, { location: target.toString() }).end();
    return;
  }
  const stage = url.pathname === '/token' ? 'token' : url.pathname === '/profile' ? 'profile' : null;
  if (!stage) {
    res.writeHead(501).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  requests.push({
    stage,
    method: req.method!,
    authorization: req.headers.authorization ?? '',
    accept: req.headers.accept ?? '',
    contentType: req.headers['content-type'] ?? '',
    body,
  });
  const currentHold = hold?.stage === stage ? hold : undefined;
  currentHold?.enter();
  if (currentHold) await currentHold.released;
  if (behavior.disconnect === stage) {
    res.destroy();
    return;
  }
  res.writeHead(behavior[stage === 'token' ? 'tokenStatus' : 'profileStatus'] ?? 200, {
    'content-type': 'application/json',
  });
  if (behavior.invalidJson === stage) {
    res.end('invalid JSON');
    return;
  }
  if (stage === 'token') {
    res.end(JSON.stringify(behavior.missingToken ? {} : { access_token: new URLSearchParams(body).get('code') }));
  } else {
    const email = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''), 'base64url').toString();
    res.end(JSON.stringify(behavior.missingEmail ? {} : { account: { email } }));
  }
}

const provider = await listenTestServer(
  http.createServer((req, res) => {
    void providerResponse(req, res).catch(() => res.destroy());
  }),
);
const edge = express();
edge.use((req, _res, next) => {
  req.headers['x-rivet-proxy-auth'] = getExpectedProxyAuthToken();
  req.headers['x-rivet-client-ip'] = '198.51.100.20';
  req.headers['x-forwarded-host'] = req.get('host');
  req.headers['x-forwarded-proto'] = 'http';
  if (req.url.startsWith('/__rivet_auth/')) req.url = req.url.replace('/__rivet_auth/', '/ui-auth/');
  next();
});
edge.use('/fixture', captureAppSettingsSnapshot);
edge.get('/fixture/status', (req, res) => {
  const ui = readServerUiOAuthSession(req);
  const visitor = readWebAppOAuthSession(req);
  res.json({
    uiEmail: ui?.email ?? null,
    uiAllowed: isServerUiAuthRequestAllowed(req),
    visitorEmail: visitor?.email ?? null,
    visitorAllowed: isWebAppOAuthSessionAllowed(visitor, ['visitor@example.test']),
  });
});
edge.get('/fixture/ui', (req, res) => {
  const allowed = isServerUiAuthRequestAllowed(req);
  res
    .status(allowed ? 200 : 403)
    .send(
      allowed
        ? '<h1>UI protected</h1><a href="/__rivet_auth/logout?return_to=/fixture/ui">Sign out UI</a>'
        : `<h1>UI denied</h1><a href="/__rivet_auth/oauth/start?return_to=/fixture/ui">Sign in UI</a>`,
    );
});
edge.get('/fixture/app', (req, res) => {
  const session = readWebAppOAuthSession(req);
  const allowed = isWebAppOAuthSessionAllowed(session, ['visitor@example.test']);
  res.status(allowed ? 200 : 403);
  if (session) {
    res.send(`<h1>App ${allowed ? 'protected' : 'denied'}</h1>
      <a href="/apps/auth/logout?return_to=/fixture/app">Sign out app</a>`);
  } else {
    const redirect = createWebAppOAuthAuthorizationRedirect(req, '/fixture/app');
    res.setHeader('Set-Cookie', redirect.cookies);
    res.send(`<h1>App denied</h1><a href="${escapeHtml(redirect.location)}">Sign in app</a>`);
  }
});
edge.use(createApiApp('control'));
const application = await listenTestServer(http.createServer(edge));

async function reset(): Promise<void> {
  hold?.release();
  hold = undefined;
  behavior = {};
  requests.length = 0;
  stopWatching?.();
  stopWatching = undefined;
  revocations = 0;
  await writeWebAppAuthSettings({
    mode: 'oauth',
    provider: 'external',
    authorizeUrl: `${provider.baseUrl}/authorize`,
    tokenUrl: `${provider.baseUrl}/token`,
    userUrl: `${provider.baseUrl}/profile`,
    clientId: 'fixture-client',
    clientSecret: 'fixture-client-secret',
    sessionSecret: 'fixture-session-v1',
    callbackUrl: `${application.baseUrl}/apps/auth/callback`,
    emailClaim: 'account.email',
    clientAuthMethod: 'body',
    serverUiAdminEmails: ['admin@example.test'],
    debugLogProfile: false,
    sessionTtlSeconds: 3600,
  });
}

function fixtureRequest(cookie = '', secure = false): Request {
  const headers: Record<string, string> = {
    cookie,
    host: 'fixture.example.test',
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
    'x-rivet-client-ip': '198.51.100.20',
    'x-forwarded-proto': secure ? 'https' : 'http',
  };
  return { headers, protocol: 'http', get: (name: string) => headers[name.toLowerCase()] } as Request;
}

async function command(name: string, value: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case 'crash':
      process.exit(1);
    case 'reset':
      await reset();
      return null;
    case 'configure':
      return writeWebAppAuthSettings(value);
    case 'behavior':
      behavior = value;
      return null;
    case 'requests':
      return requests;
    case 'hold': {
      hold?.release();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (value.stage !== 'token' && value.stage !== 'profile') throw Error('Invalid held stage');
      hold = { stage: value.stage, entered, enter, released, release };
      return null;
    }
    case 'wait-held':
      if (!hold) throw Error('No held stage');
      await hold.entered;
      return null;
    case 'release':
      hold?.release();
      return null;
    case 'start': {
      const req = fixtureRequest();
      return value.surface === 'ui'
        ? createServerUiOAuthAuthorizationRedirect(req, '/fixture/ui')
        : createWebAppOAuthAuthorizationRedirect(req, '/fixture/app');
    }
    case 'sign':
      return sign(value.payload as object);
    case 'direct-ui':
      return completeServerUiOAuthCallback(fixtureRequest(), String(value.code));
    case 'watch-ui':
      stopWatching?.();
      stopWatching = runWithAppSettingsSnapshot(() =>
        watchAuthorization(
          () => isServerUiAuthRequestAllowed(fixtureRequest(String(value.cookie))),
          () => {
            revocations++;
          },
        ),
      );
      return null;
    case 'revocations':
      return revocations;
    case 'wire': {
      await writeWebAppAuthSettings({
        authorizeUrl: 'https://oauth.example.test/authorize',
        tokenUrl: 'https://oauth.example.test/token',
        userUrl: 'https://oauth.example.test/profile',
        callbackUrl: 'http://127.0.0.1/apps/auth/callback',
      });
      const uiVersion = getServerUiOAuthSettingsVersion();
      const visitorVersion = decode(
        new URL(createWebAppOAuthAuthorizationRedirect(fixtureRequest(), '/fixture/app').location).searchParams.get(
          'state',
        )!,
      ).settingsVersion;
      const payload = { email: 'admin@example.test', expiresAt: 4_102_444_800_000, settingsVersion: uiVersion };
      const uiToken = sign(payload);
      const visitorToken = sign({ ...payload, email: 'visitor@example.test', settingsVersion: visitorVersion });
      return {
        uiVersion,
        visitorVersion,
        uiToken,
        visitorToken,
        uiRead: readServerUiOAuthSession(fixtureRequest(`rivet_ui_oauth_session=${uiToken}`)),
        visitorRead: readWebAppOAuthSession(fixtureRequest(`rivet_web_app_oauth_session=${visitorToken}`)),
        crossUi: readServerUiOAuthSession(fixtureRequest(`rivet_ui_oauth_session=${visitorToken}`)),
        crossVisitor: readWebAppOAuthSession(fixtureRequest(`rivet_web_app_oauth_session=${uiToken}`)),
        cookies: [
          createCookie('example', 'A==', fixtureRequest(), 600),
          createCookie('example', 'A==', fixtureRequest('', true), 600),
          clearCookie('example', fixtureRequest()),
          clearCookie('example', fixtureRequest('', true)),
        ],
      };
    }
    default:
      throw Error(`Unknown OAuth fixture command: ${name}`);
  }
}

let closing: Promise<void> | undefined;
function close(): Promise<void> {
  return (closing ??= (async () => {
    hold?.release();
    stopWatching?.();
    const results = await Promise.allSettled([application.close(), provider.close()]);
    results.push(
      await disposeAppSettingsRepositories().then(
        () => ({ status: 'fulfilled' as const, value: undefined }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'OAuth fixture cleanup failed',
      );
  })());
}

await reset();
process.on('message', (message: { id: number; command: string; value?: Record<string, unknown> }) => {
  void (async () => {
    try {
      const result = message.command === 'shutdown' ? await close() : await command(message.command, message.value);
      process.send!({ id: message.id, result }, () => {
        if (message.command === 'shutdown') process.disconnect();
      });
    } catch (error) {
      process.send!({ id: message.id, error: error instanceof Error ? error.message : String(error) }, () => {
        if (message.command === 'shutdown') process.disconnect();
      });
    }
  })();
});
process.on('disconnect', () => {
  void close();
});
process.send({ ready: { baseUrl: application.baseUrl } });
