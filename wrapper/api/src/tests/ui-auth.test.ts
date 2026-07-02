import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../auth.js';
import { getServerUiAuthMode } from '../server-ui-auth.js';
import { uiAuthRouter } from '../routes/ui-auth.js';
import { writeWebAppAuthSettings } from '../web-app-auth-settings.js';
import {
  addUiAuthErrorToReturnTo,
  removeUiAuthErrorFromReturnTo,
  sanitizeUiAuthReturnTo,
} from '../ui-auth-utils.js';

const SERVER_UI_AUTH_ENV_KEYS = [
  'RIVET_KEY',
  'RIVET_APP_DATA_ROOT',
  'RIVET_REQUIRE_UI_GATE_KEY',
  'RIVET_SERVER_UI_AUTH_MODE',
] as const;

type ServerUiAuthEnv = Partial<Record<typeof SERVER_UI_AUTH_ENV_KEYS[number], string | undefined>>;

const RETIRED_SERVER_UI_OAUTH_ENV_KEYS = [
  'RIVET_SERVER_UI_OAUTH_PROVIDER',
  'RIVET_SERVER_UI_OAUTH_DUMMY_EMAIL',
  'RIVET_SERVER_UI_OAUTH_DUMMY_ALLOW_NON_LOCALHOST',
  'RIVET_SERVER_UI_OAUTH_AUTHORIZE_URL',
  'RIVET_SERVER_UI_OAUTH_TOKEN_URL',
  'RIVET_SERVER_UI_OAUTH_USER_URL',
  'RIVET_SERVER_UI_OAUTH_CLIENT_ID',
  'RIVET_SERVER_UI_OAUTH_CLIENT_SECRET',
  'RIVET_SERVER_UI_OAUTH_CALLBACK_URL',
  'RIVET_SERVER_UI_OAUTH_SCOPES',
  'RIVET_SERVER_UI_OAUTH_EMAIL_CLAIM',
  'RIVET_SERVER_UI_OAUTH_SESSION_SECRET',
  'RIVET_SERVER_UI_OAUTH_SESSION_TTL_SECONDS',
  'RIVET_SERVER_UI_OAUTH_CLIENT_AUTH_METHOD',
  'RIVET_SERVER_UI_OAUTH_DEBUG_LOG_PROFILE',
  'RIVET_SERVER_UI_OAUTH_ADMIN_EMAILS',
] as const;

async function withServerUiAuthEnv(values: ServerUiAuthEnv, run: () => Promise<void> | void): Promise<void> {
  const previous = new Map<string, string | undefined>();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-server-ui-auth-'));
  for (const key of [...SERVER_UI_AUTH_ENV_KEYS, ...RETIRED_SERVER_UI_OAUTH_ENV_KEYS]) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    process.env.RIVET_KEY = 'server-ui-auth-test-key';
    process.env.RIVET_APP_DATA_ROOT = path.join(tempRoot, 'app-data');
    for (const [key, value] of Object.entries(values)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await run();
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function writeDummyServerUiOAuthSettings(adminEmails: string[]): Promise<void> {
  await writeWebAppAuthSettings({
    mode: 'ui-gate',
    provider: 'dummy',
    dummyEmail: 'admin@example.test',
    sessionSecret: 'server-ui-session-secret',
    serverUiAdminEmails: adminEmails,
  });
}

async function withUiAuthServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/', uiAuthRouter);
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function trustedProxyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
    'x-forwarded-host': '127.0.0.1',
    'x-forwarded-proto': 'http',
  };
}

function getCookieValue(setCookieHeader: string, name: string): string {
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Expected ${name} cookie`);
  return match[1]!;
}

test('UI auth return paths preserve local app routes', () => {
  assert.equal(sanitizeUiAuthReturnTo('/'), '/');
  assert.equal(sanitizeUiAuthReturnTo('/apps/test-web-app/'), '/apps/test-web-app/');
  assert.equal(
    sanitizeUiAuthReturnTo('/apps/test-web-app/?question=hello#result'),
    '/apps/test-web-app/?question=hello#result',
  );
});

test('UI auth return paths reject external or malformed redirects', () => {
  for (const candidate of [
    undefined,
    '',
    'apps/test-web-app/',
    '//evil.test/apps/test-web-app/',
    'https://evil.test/apps/test-web-app/',
    '/apps/test-web-app/\nSet-Cookie: bad=1',
    '/apps\\test-web-app',
  ]) {
    assert.equal(sanitizeUiAuthReturnTo(candidate), '/');
  }
});

test('UI auth form errors return to the original page with auth_error added', () => {
  assert.equal(
    addUiAuthErrorToReturnTo('/apps/test-web-app/?question=hello#result', 'invalid'),
    '/apps/test-web-app/?question=hello&auth_error=invalid#result',
  );
  assert.equal(addUiAuthErrorToReturnTo('/?editor', 'forbidden'), '/?editor=&auth_error=forbidden');
  assert.equal(addUiAuthErrorToReturnTo('https://evil.test/', 'invalid'), '/?auth_error=invalid');
});

test('UI auth retry links strip stale auth_error from return paths', () => {
  assert.equal(
    removeUiAuthErrorFromReturnTo('/apps/test-web-app/?question=hello&auth_error=invalid#result'),
    '/apps/test-web-app/?question=hello#result',
  );
  assert.equal(removeUiAuthErrorFromReturnTo('/?auth_error=oauth_denied'), '/');
  assert.equal(removeUiAuthErrorFromReturnTo('https://evil.test/?auth_error=invalid'), '/');
});

test('server UI auth mode defaults to legacy key env when explicit mode is unset', async () => {
  await withServerUiAuthEnv({}, () => {
    assert.equal(getServerUiAuthMode(), 'none');
  });
  await withServerUiAuthEnv({ RIVET_REQUIRE_UI_GATE_KEY: 'true' }, () => {
    assert.equal(getServerUiAuthMode(), 'key');
  });
  await withServerUiAuthEnv({ RIVET_REQUIRE_UI_GATE_KEY: 'true', RIVET_SERVER_UI_AUTH_MODE: 'oauth' }, () => {
    assert.equal(getServerUiAuthMode(), 'oauth');
  });
});

test('server UI auth check accepts the Rivet key session in key mode', async () => {
  await withServerUiAuthEnv({ RIVET_SERVER_UI_AUTH_MODE: 'key' }, async () => {
    await withUiAuthServer(async (baseUrl) => {
      const anonymous = await fetch(`${baseUrl}/ui-auth/check`, {
        headers: trustedProxyHeaders(),
      });
      assert.equal(anonymous.status, 401);

      const authorized = await fetch(`${baseUrl}/ui-auth/check`, {
        headers: trustedProxyHeaders({
          cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
        }),
      });
      assert.equal(authorized.status, 204);
    });
  });
});

test('server UI prompts keep the error message but retry against a clean return path', async () => {
  await withServerUiAuthEnv({ RIVET_SERVER_UI_AUTH_MODE: 'key' }, async () => {
    await withUiAuthServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ui-auth/prompt`, {
        headers: trustedProxyHeaders({
          'x-rivet-ui-return-to': '/apps/example?auth_error=invalid',
        }),
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /Access key was rejected/);
      assert.match(html, /name="return_to" type="hidden" value="\/apps\/example"/);
      assert.doesNotMatch(html, /name="return_to" type="hidden" value="\/apps\/example\?auth_error=invalid"/);
    });
  });

  await withServerUiAuthEnv({
    RIVET_SERVER_UI_AUTH_MODE: 'oauth',
  }, async () => {
    await writeDummyServerUiOAuthSettings(['admin@example.test']);
    await withUiAuthServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ui-auth/prompt`, {
        headers: trustedProxyHeaders({
          'x-rivet-ui-return-to': '/apps/example?auth_error=oauth_denied',
        }),
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /OAuth provider rejected/);
      assert.match(html, /\/__rivet_auth\/oauth\/start\?return_to=%2Fapps%2Fexample"/);
      assert.doesNotMatch(html, /auth_error=oauth_denied/);
    });
  });
});

test('server UI dummy OAuth creates an admin session and rejects non-admin email', async () => {
  await withServerUiAuthEnv({
    RIVET_SERVER_UI_AUTH_MODE: 'oauth',
  }, async () => {
    await writeDummyServerUiOAuthSettings(['admin@example.test']);
    await withUiAuthServer(async (baseUrl) => {
      const start = await fetch(`${baseUrl}/ui-auth/oauth/start?return_to=%2Fprojects`, {
        redirect: 'manual',
        headers: trustedProxyHeaders({ host: '127.0.0.1' }),
      });
      assert.equal(start.status, 302);
      const stateCookie = getCookieValue(start.headers.get('set-cookie') ?? '', 'rivet_ui_oauth_state');
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
      assert.ok(state);

      const deniedDummy = await fetch(`${baseUrl}/ui-auth/oauth/dummy`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...trustedProxyHeaders({ host: '127.0.0.1' }),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ state, email: 'other@example.test' }),
      });
      const deniedCallbackPath = deniedDummy.headers.get('location') ?? '';
      const deniedCallback = await fetch(`${baseUrl}${deniedCallbackPath.replace('/__rivet_auth', '/ui-auth')}`, {
        redirect: 'manual',
        headers: trustedProxyHeaders({
          host: '127.0.0.1',
          cookie: `rivet_ui_oauth_state=${stateCookie}`,
        }),
      });
      assert.equal(deniedCallback.status, 303);
      assert.equal(deniedCallback.headers.get('location'), '/projects?auth_error=oauth_forbidden');
      assert.doesNotMatch(deniedCallback.headers.get('set-cookie') ?? '', /rivet_ui_oauth_session=/);

      const allowedDummy = await fetch(`${baseUrl}/ui-auth/oauth/dummy`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...trustedProxyHeaders({ host: '127.0.0.1' }),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ state, email: 'admin@example.test' }),
      });
      const allowedCallbackPath = allowedDummy.headers.get('location') ?? '';
      const allowedCallback = await fetch(`${baseUrl}${allowedCallbackPath.replace('/__rivet_auth', '/ui-auth')}`, {
        redirect: 'manual',
        headers: trustedProxyHeaders({
          host: '127.0.0.1',
          cookie: `rivet_ui_oauth_state=${stateCookie}`,
        }),
      });
      assert.equal(allowedCallback.status, 303);
      assert.equal(allowedCallback.headers.get('location'), '/projects');
      const sessionCookie = getCookieValue(allowedCallback.headers.get('set-cookie') ?? '', 'rivet_ui_oauth_session');

      const authorized = await fetch(`${baseUrl}/ui-auth/check`, {
        headers: trustedProxyHeaders({
          cookie: `rivet_ui_oauth_session=${sessionCookie}`,
        }),
      });
      assert.equal(authorized.status, 204);

      await writeDummyServerUiOAuthSettings(['someone-else@example.test']);
      const stale = await fetch(`${baseUrl}/ui-auth/check`, {
        headers: trustedProxyHeaders({
          cookie: `rivet_ui_oauth_session=${sessionCookie}`,
        }),
      });
      assert.equal(stale.status, 401);
    });
  });
});

test('server UI OAuth uses saved app settings instead of retired server OAuth env', async () => {
  await withServerUiAuthEnv({
    RIVET_SERVER_UI_AUTH_MODE: 'oauth',
  }, async () => {
    process.env.RIVET_SERVER_UI_OAUTH_PROVIDER = 'external';
    process.env.RIVET_SERVER_UI_OAUTH_ADMIN_EMAILS = 'other@example.test';
    process.env.RIVET_SERVER_UI_OAUTH_SESSION_SECRET = 'retired-secret';
    await writeDummyServerUiOAuthSettings(['admin@example.test']);

    await withUiAuthServer(async (baseUrl) => {
      const start = await fetch(`${baseUrl}/ui-auth/oauth/start?return_to=%2Fprojects`, {
        redirect: 'manual',
        headers: trustedProxyHeaders({ host: '127.0.0.1' }),
      });
      assert.equal(start.status, 302);
      assert.match(start.headers.get('location') ?? '', /\/__rivet_auth\/oauth\/dummy\?/);
    });
  });
});
