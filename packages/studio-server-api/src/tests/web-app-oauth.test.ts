import http from 'node:http';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';

import { getExpectedProxyAuthToken } from '../auth.js';
import {
  createWebAppOAuthAuthorizationRedirect,
  getWebAppAuthMode,
  isWebAppOAuthSessionAllowed,
  readWebAppOAuthSession,
  WEB_APP_OAUTH_SELECT_ACCOUNT_PROMPT,
  webAppOAuthRouter,
  type WebAppOAuthSession,
} from '../web-app-oauth.js';
import { writeWebAppAuthSettings } from '../web-app-auth-settings.js';

type MockRequest = {
  protocol?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string>;
  get(name: string): string | undefined;
};

const OAUTH_ENV_KEYS = [
  'RIVET_KEY',
  'RIVET_APP_DATA_ROOT',
  'RIVET_WEB_APPS_AUTH_MODE',
  'OAUTH_PROVIDER',
  'OAUTH_DUMMY_EMAIL',
  'OAUTH_DUMMY_ALLOW_NON_LOCALHOST',
  'OAUTH_AUTHORIZE_URL',
  'OAUTH_TOKEN_URL',
  'OAUTH_USER_URL',
  'OAUTH_CLIENT_ID',
  'OAUTH_CLIENT_SECRET',
  'OAUTH_CALLBACK_URL',
  'OAUTH_SCOPES',
  'OAUTH_EMAIL_CLAIM',
  'OAUTH_SESSION_SECRET',
  'OAUTH_SESSION_TTL_SECONDS',
  'OAUTH_CLIENT_AUTH_METHOD',
  'OAUTH_DEBUG_LOG_PROFILE',
] as const;

type LegacyOAuthEnvValues = Partial<Record<typeof OAUTH_ENV_KEYS[number], string | undefined>>;

function createMockRequest(headers: Record<string, string> = {}): MockRequest {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    protocol: 'http',
    headers: normalizedHeaders,
    get(name: string): string | undefined {
      return normalizedHeaders[name.toLowerCase()];
    },
  };
}

async function withEnv(values: LegacyOAuthEnvValues, run: () => Promise<void> | void): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of OAUTH_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-web-app-oauth-'));

  try {
    for (const key of OAUTH_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.RIVET_KEY = 'web-app-oauth-test-key';
    process.env.RIVET_APP_DATA_ROOT = path.join(tempRoot, 'app-data');

    const hasOAuthValues = Object.keys(values).some((key) => key.startsWith('OAUTH_'));
    const hasExternalProviderValues = Boolean(
      values.OAUTH_AUTHORIZE_URL ||
      values.OAUTH_TOKEN_URL ||
      values.OAUTH_USER_URL ||
      values.OAUTH_CLIENT_ID ||
      values.OAUTH_CALLBACK_URL ||
      values.OAUTH_SCOPES ||
      values.OAUTH_EMAIL_CLAIM ||
      values.OAUTH_CLIENT_AUTH_METHOD ||
      values.OAUTH_DEBUG_LOG_PROFILE,
    );
    const mode = values.RIVET_WEB_APPS_AUTH_MODE ??
      (values.OAUTH_PROVIDER === 'dummy' || hasExternalProviderValues ? 'oauth' : 'ui-gate');

    if (values.RIVET_WEB_APPS_AUTH_MODE != null || hasOAuthValues) {
      await writeWebAppAuthSettings({
        mode,
        provider: values.OAUTH_PROVIDER === 'dummy' || (mode === 'oauth' && !hasExternalProviderValues) ? 'dummy' : 'external',
        dummyEmail: values.OAUTH_DUMMY_EMAIL,
        dummyAllowNonLocalhost: values.OAUTH_DUMMY_ALLOW_NON_LOCALHOST,
        authorizeUrl: values.OAUTH_AUTHORIZE_URL,
        tokenUrl: values.OAUTH_TOKEN_URL,
        userUrl: values.OAUTH_USER_URL,
        clientId: values.OAUTH_CLIENT_ID,
        clientSecret: values.OAUTH_CLIENT_SECRET,
        callbackUrl: values.OAUTH_CALLBACK_URL,
        scopes: values.OAUTH_SCOPES,
        emailClaim: values.OAUTH_EMAIL_CLAIM,
        sessionSecret: values.OAUTH_SESSION_SECRET ?? (mode === 'oauth' && !hasExternalProviderValues ? 'session-secret' : undefined),
        sessionTtlSeconds: values.OAUTH_SESSION_TTL_SECONDS,
        clientAuthMethod: values.OAUTH_CLIENT_AUTH_METHOD,
        debugLogProfile: values.OAUTH_DEBUG_LOG_PROFILE,
      });
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

function trustedProxyHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
  };
}

function getCookieValue(setCookieHeader: string, name: string): string {
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Expected ${name} cookie`);
  return match[1]!;
}

async function withOAuthCallbackServer(
  run: (baseUrl: string) => Promise<void>,
  mountPath = '/',
): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(mountPath, webAppOAuthRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('web app auth mode defaults to ui-gate unless an explicit supported mode is configured', async () => {
  await withEnv({}, () => {
    assert.equal(getWebAppAuthMode(), 'ui-gate');
  });
  await withEnv({ RIVET_WEB_APPS_AUTH_MODE: 'oauth' }, () => {
    assert.equal(getWebAppAuthMode(), 'oauth');
  });
  await withEnv({ RIVET_WEB_APPS_AUTH_MODE: 'none' }, () => {
    assert.equal(getWebAppAuthMode(), 'none');
  });
  await withEnv({ RIVET_WEB_APPS_AUTH_MODE: 'surprise' }, () => {
    assert.equal(getWebAppAuthMode(), 'ui-gate');
  });
});

test('web app OAuth redirect stores state and sanitizes return targets', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'https://rivet.example.test/apps/auth/callback',
  }, () => {
    const redirect = createWebAppOAuthAuthorizationRedirect(
      createMockRequest(trustedProxyHeaders({
        host: 'api.internal:80',
        'x-forwarded-host': 'rivet.example.test',
        'x-forwarded-proto': 'https',
      })) as any,
      'https://evil.example.test/apps/owned',
    );
    const location = new URL(redirect.location);
    assert.equal(location.origin, 'https://oauth.example.test');
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), 'client-id');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://rivet.example.test/apps/auth/callback');
    assert.ok(location.searchParams.get('state'));
    assert.match(redirect.cookies.join('\n'), /rivet_web_app_oauth_state=/);
    assert.match(redirect.cookies.join('\n'), /Secure/);
  });
});

test('web app OAuth redirect can request provider account selection', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'https://rivet.example.test/apps/auth/callback',
  }, () => {
    const redirect = createWebAppOAuthAuthorizationRedirect(
      createMockRequest(trustedProxyHeaders({
        host: 'api.internal:80',
        'x-forwarded-host': 'rivet.example.test',
        'x-forwarded-proto': 'https',
      })) as any,
      '/apps/my-tool?auth_prompt=select_account',
      { prompt: WEB_APP_OAUTH_SELECT_ACCOUNT_PROMPT },
    );
    const location = new URL(redirect.location);
    assert.equal(location.searchParams.get('prompt'), 'select_account');

    const state = location.searchParams.get('state') ?? '';
    const statePayload = JSON.parse(Buffer.from(state.split('.')[0] ?? '', 'base64url').toString('utf8')) as { returnTo?: string };
    assert.equal(statePayload.returnTo, '/apps/my-tool');
  });
});

test('web app OAuth provider URLs must be HTTPS unless they target localhost', async () => {
  await assert.rejects(
    withEnv({
      OAUTH_AUTHORIZE_URL: 'http://oauth.example.test/authorize',
      OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
      OAUTH_USER_URL: 'https://oauth.example.test/profile',
      OAUTH_CLIENT_ID: 'client-id',
      OAUTH_CLIENT_SECRET: 'client-secret',
      OAUTH_SESSION_SECRET: 'session-secret',
    }, () => {}),
    /Authorization URL must use https unless it targets localhost/,
  );

  await withEnv({
    OAUTH_AUTHORIZE_URL: 'http://localhost:9080/authorize',
    OAUTH_TOKEN_URL: 'http://127.0.0.1:9080/token',
    OAUTH_USER_URL: 'http://[::1]:9080/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://localhost:8081/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, () => {
    assert.doesNotThrow(() => createWebAppOAuthAuthorizationRedirect(
      createMockRequest({ host: 'localhost:8081' }) as any,
      '/apps/my-tool',
    ));
  });
});

test('web app OAuth redirect uses forwarded host when no explicit callback URL is configured', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
  }, () => {
    const redirect = createWebAppOAuthAuthorizationRedirect(
      createMockRequest(trustedProxyHeaders({
        host: 'api.internal:80',
        'x-forwarded-host': 'rivet.example.test',
        'x-forwarded-proto': 'https',
      })) as any,
      '/apps/my-tool',
    );
    const location = new URL(redirect.location);
    assert.equal(location.searchParams.get('redirect_uri'), 'https://rivet.example.test/apps/auth/callback');
  });
});

test('web app OAuth redirect preserves forwarded host ports for browser-facing URLs', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
  }, () => {
    const redirect = createWebAppOAuthAuthorizationRedirect(
      createMockRequest(trustedProxyHeaders({
        host: 'api.internal:80',
        'x-forwarded-host': 'localhost:8081',
        'x-forwarded-proto': 'http',
      })) as any,
      '/apps/my-tool',
    );
    const location = new URL(redirect.location);
    assert.equal(location.searchParams.get('redirect_uri'), 'http://localhost:8081/apps/auth/callback');
  });

  await withEnv({
    OAUTH_PROVIDER: 'dummy',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, () => {
    const redirect = createWebAppOAuthAuthorizationRedirect(
      createMockRequest(trustedProxyHeaders({
        host: 'api.internal:80',
        'x-forwarded-host': 'localhost:8081',
        'x-forwarded-proto': 'http',
      })) as any,
      '/apps/my-tool',
    );
    const location = new URL(redirect.location);
    assert.equal(location.origin, 'http://localhost:8081');
    assert.equal(location.pathname, '/apps/auth/dummy');
  });
});

test('web app dummy OAuth provider signs in locally without external provider endpoints', async () => {
  await withEnv({
    OAUTH_PROVIDER: 'dummy',
    OAUTH_DUMMY_EMAIL: 'default@example.test',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    await withOAuthCallbackServer(async (baseUrl) => {
      const base = new URL(baseUrl);
      const redirect = createWebAppOAuthAuthorizationRedirect(
        createMockRequest({ host: base.host, 'x-forwarded-proto': 'http' }) as any,
        '/apps/dummy-tool',
      );
      const location = new URL(redirect.location);
      assert.equal(location.origin, base.origin);
      assert.equal(location.pathname, '/apps/auth/dummy');
      assert.equal(location.searchParams.get('response_type'), null);
      assert.equal(location.searchParams.get('client_id'), null);
      const state = location.searchParams.get('state');
      assert.ok(state);
      const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

      const pageResponse = await fetch(redirect.location);
      assert.equal(pageResponse.status, 200);
      const pageHtml = await pageResponse.text();
      assert.match(pageHtml, /Dummy OAuth sign in/);
      assert.match(pageHtml, /value="default@example\.test"/);

      const providerResponse = await fetch(`${baseUrl}/apps/auth/dummy`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state,
          email: 'Allowed@example.test',
        }),
        redirect: 'manual',
      });
      assert.equal(providerResponse.status, 303);
      const callbackLocation = providerResponse.headers.get('location') ?? '';
      assert.match(callbackLocation, /^\/apps\/auth\/callback\?/);

      const callbackResponse = await fetch(`${baseUrl}${callbackLocation}`, {
        headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
        redirect: 'manual',
      });
      assert.equal(callbackResponse.status, 303);
      assert.equal(callbackResponse.headers.get('location'), '/apps/dummy-tool');
      const setCookie = callbackResponse.headers.get('set-cookie') ?? '';
      const sessionCookie = getCookieValue(setCookie, 'rivet_web_app_oauth_session');
      const session = readWebAppOAuthSession(createMockRequest({
        cookie: `rivet_web_app_oauth_session=${sessionCookie}`,
      }) as any) as WebAppOAuthSession | null;
      assert.deepEqual(session?.email, 'allowed@example.test');
    }, '/apps');
  });
});

test('web app dummy OAuth provider refuses non-localhost redirect starts by default', async () => {
  await withEnv({
    OAUTH_PROVIDER: 'dummy',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, () => {
    assert.throws(
      () => createWebAppOAuthAuthorizationRedirect(
        createMockRequest({ host: 'rivet.example.test', 'x-forwarded-proto': 'https' }) as any,
        '/apps/dummy-tool',
      ),
      /Dummy OAuth is only available for localhost requests/,
    );
  });
});

test('web app OAuth callback exchanges code, sets session cookie, and supports allowlists', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth.example.test/token') {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://oauth.example.test/profile') {
        return new Response(JSON.stringify({ email: 'USER@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/my-tool/?x=1#top',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        const callbackResponse = await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });

        assert.equal(callbackResponse.status, 303);
        assert.equal(callbackResponse.headers.get('location'), '/apps/my-tool/?x=1#top');
        const setCookie = callbackResponse.headers.get('set-cookie') ?? '';
        const sessionCookie = getCookieValue(setCookie, 'rivet_web_app_oauth_session');
        const session = readWebAppOAuthSession(createMockRequest({
          cookie: `rivet_web_app_oauth_session=${sessionCookie}`,
        }) as any) as WebAppOAuthSession | null;
        assert.deepEqual(session?.email, 'user@example.com');
        assert.equal(isWebAppOAuthSessionAllowed(session, []), false);
        assert.equal(isWebAppOAuthSessionAllowed(session, ['USER@example.com']), true);
        assert.equal(isWebAppOAuthSessionAllowed(session, ['other@example.com']), false);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('web app OAuth sessions are rejected after OAuth settings change', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth.example.test/token') {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://oauth.example.test/profile') {
        return new Response(JSON.stringify({ email: 'USER@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/my-tool',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        const callbackResponse = await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });
        const sessionCookie = getCookieValue(
          callbackResponse.headers.get('set-cookie') ?? '',
          'rivet_web_app_oauth_session',
        );
        const sessionRequest = createMockRequest({
          cookie: `rivet_web_app_oauth_session=${sessionCookie}`,
        }) as any;

        assert.equal(readWebAppOAuthSession(sessionRequest)?.email, 'user@example.com');

        await writeWebAppAuthSettings({
          mode: 'oauth',
          provider: 'external',
          authorizeUrl: 'https://oauth.example.test/authorize',
          tokenUrl: 'https://oauth.example.test/token',
          userUrl: 'https://oauth.example.test/profile',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          callbackUrl: 'http://127.0.0.1/apps/auth/callback',
          scopes: 'email profile',
          sessionSecret: 'session-secret',
        });

        assert.equal(readWebAppOAuthSession(sessionRequest), null);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('web app OAuth sessions are rejected after client secret rotation', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'stable-session-secret',
  }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth.example.test/token') {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://oauth.example.test/profile') {
        return new Response(JSON.stringify({ email: 'USER@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/my-tool',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        const callbackResponse = await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });
        const sessionCookie = getCookieValue(
          callbackResponse.headers.get('set-cookie') ?? '',
          'rivet_web_app_oauth_session',
        );
        const sessionRequest = createMockRequest({
          cookie: `rivet_web_app_oauth_session=${sessionCookie}`,
        }) as any;

        assert.equal(readWebAppOAuthSession(sessionRequest)?.email, 'user@example.com');

        await writeWebAppAuthSettings({
          mode: 'oauth',
          provider: 'external',
          authorizeUrl: 'https://oauth.example.test/authorize',
          tokenUrl: 'https://oauth.example.test/token',
          userUrl: 'https://oauth.example.test/profile',
          clientId: 'client-id',
          clientSecret: 'rotated-client-secret',
          callbackUrl: 'http://127.0.0.1/apps/auth/callback',
          sessionSecret: 'stable-session-secret',
        });

        assert.equal(readWebAppOAuthSession(sessionRequest), null);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('web app OAuth sessions without a settings version are rejected', async () => {
  await withEnv({
    OAUTH_PROVIDER: 'dummy',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, () => {
    const payload = Buffer.from(JSON.stringify({
      email: 'user@example.com',
      expiresAt: Date.now() + 60_000,
    }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', 'session-secret').update(payload).digest('base64url');

    assert.equal(readWebAppOAuthSession(createMockRequest({
      cookie: `rivet_web_app_oauth_session=${payload}.${signature}`,
    }) as any), null);
  });
});

test('web app OAuth callback returns to the original app when provider errors without state', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    await withOAuthCallbackServer(async (baseUrl) => {
      const redirect = createWebAppOAuthAuthorizationRedirect(
        createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
        '/apps/my-tool/?x=1#top',
      );
      const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

      const callbackResponse = await fetch(`${baseUrl}/auth/callback?error=invalid_scope`, {
        headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
        redirect: 'manual',
      });

      assert.equal(callbackResponse.status, 303);
      assert.equal(callbackResponse.headers.get('location'), '/apps/my-tool/?x=1&auth_error=oauth_denied#top');
    });
  });
});

test('web app OAuth callback treats stale state as invalid when OAuth settings were cleared', async () => {
  await withEnv({}, async () => {
    await withOAuthCallbackServer(async (baseUrl) => {
      const callbackResponse = await fetch(`${baseUrl}/auth/callback?code=abc&state=stale.payload`, {
        headers: { cookie: 'rivet_web_app_oauth_state=stale.cookie' },
        redirect: 'manual',
      });

      assert.equal(callbackResponse.status, 303);
      assert.equal(callbackResponse.headers.get('location'), '/?auth_error=oauth_state');
      assert.match(callbackResponse.headers.get('set-cookie') ?? '', /rivet_web_app_oauth_state=;/);
    });
  });
});

test('web app OAuth callback does not create a session after OAuth is disabled', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    await withOAuthCallbackServer(async (baseUrl) => {
      const redirect = createWebAppOAuthAuthorizationRedirect(
        createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
        '/apps/my-tool',
      );
      const state = new URL(redirect.location).searchParams.get('state');
      assert.ok(state);
      const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

      await writeWebAppAuthSettings({ mode: 'ui-gate' });

      const callbackResponse = await fetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
        headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
        redirect: 'manual',
      });

      assert.equal(callbackResponse.status, 303);
      assert.equal(callbackResponse.headers.get('location'), '/apps/my-tool?auth_error=oauth_state');
      const setCookie = callbackResponse.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /rivet_web_app_oauth_state=;/);
      assert.doesNotMatch(setCookie, /rivet_web_app_oauth_session=/);
    });
  });
});

test('web app OAuth callback does not create a session after OAuth settings change during sign-in', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    const originalFetch = globalThis.fetch;
    let fetchWasCalled = false;
    globalThis.fetch = (async () => {
      fetchWasCalled = true;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/my-tool',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        await writeWebAppAuthSettings({
          mode: 'oauth',
          provider: 'external',
          authorizeUrl: 'https://oauth.example.test/authorize',
          tokenUrl: 'https://oauth.example.test/token',
          userUrl: 'https://oauth.example.test/profile',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          callbackUrl: 'http://127.0.0.1/apps/auth/callback',
          scopes: 'email profile',
          sessionSecret: 'session-secret',
        });

        const callbackResponse = await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });

        assert.equal(callbackResponse.status, 303);
        assert.equal(callbackResponse.headers.get('location'), '/apps/my-tool?auth_error=oauth_state');
        const setCookie = callbackResponse.headers.get('set-cookie') ?? '';
        assert.match(setCookie, /rivet_web_app_oauth_state=;/);
        assert.doesNotMatch(setCookie, /rivet_web_app_oauth_session=/);
        assert.equal(fetchWasCalled, false);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('web app OAuth callback returns to the original app when profile has no configured email claim', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth.example.test/token') {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://oauth.example.test/profile') {
        return new Response(JSON.stringify({ name: 'User Without Email' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/my-tool',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        const callbackResponse = await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });

        assert.equal(callbackResponse.status, 303);
        assert.equal(callbackResponse.headers.get('location'), '/apps/my-tool?auth_error=oauth_profile');
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('web app OAuth callback can log the raw profile response for claim discovery', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_SESSION_SECRET: 'session-secret',
    OAUTH_DEBUG_LOG_PROFILE: 'true',
  }, async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://oauth.example.test/token') {
        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://oauth.example.test/profile') {
        return new Response(JSON.stringify({ data: { email: 'USER@example.com' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/profile-debug-tool',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });

        assert.deepEqual(warnings, [[
          '[web-app-oauth] OAuth profile response:',
          JSON.stringify({ data: { email: 'USER@example.com' } }),
        ]]);
      });
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });
});

test('web app OAuth logout clears OAuth cookies and returns to the requested app', async () => {
  await withEnv({
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    await withOAuthCallbackServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/logout?return_to=${encodeURIComponent('/apps/my-tool?x=1')}`, {
        redirect: 'manual',
      });

      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/apps/my-tool?x=1');
      const setCookie = response.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /rivet_web_app_oauth_state=;/);
      assert.match(setCookie, /rivet_web_app_oauth_session=;/);
      assert.match(setCookie, /Max-Age=0/);

      const externalReturnResponse = await fetch(
        `${baseUrl}/auth/logout?return_to=${encodeURIComponent('https://evil.example.test/apps/my-tool')}`,
        { redirect: 'manual' },
      );

      assert.equal(externalReturnResponse.status, 303);
      assert.equal(externalReturnResponse.headers.get('location'), '/');

      const switchAccountResponse = await fetch(
        `${baseUrl}/auth/logout?return_to=${encodeURIComponent('/apps/my-tool?x=1&auth_action=login&auth_prompt=select_account&auth_error=oauth_failed#top')}&select_account=1`,
        { redirect: 'manual' },
      );

      assert.equal(switchAccountResponse.status, 303);
      assert.equal(
        switchAccountResponse.headers.get('location'),
        '/apps/my-tool?x=1&auth_prompt=select_account#top',
      );
    });
  });
});

test('web app OAuth callback supports basic client authentication for strict providers', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/apps/auth/callback',
    OAUTH_CLIENT_AUTH_METHOD: 'basic',
    OAUTH_SESSION_SECRET: 'session-secret',
  }, async () => {
    const originalFetch = globalThis.fetch;
    let sawTokenRequest = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth.example.test/token') {
        sawTokenRequest = true;
        const headers = new Headers(init?.headers);
        const body = init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(String(init?.body ?? ''));

        assert.equal(init?.method, 'POST');
        assert.equal(headers.get('authorization'), `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('client_id'), null);
        assert.equal(body.get('client_secret'), null);

        return new Response(JSON.stringify({ access_token: 'access-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url === 'https://oauth.example.test/profile') {
        return new Response(JSON.stringify({ email: 'user@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      await withOAuthCallbackServer(async (baseUrl) => {
        const redirect = createWebAppOAuthAuthorizationRedirect(
          createMockRequest({ host: '127.0.0.1', 'x-forwarded-proto': 'http' }) as any,
          '/apps/basic-auth-tool',
        );
        const state = new URL(redirect.location).searchParams.get('state');
        assert.ok(state);
        const stateCookie = getCookieValue(redirect.cookies.join('; '), 'rivet_web_app_oauth_state');

        const callbackResponse = await originalFetch(`${baseUrl}/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `rivet_web_app_oauth_state=${stateCookie}` },
          redirect: 'manual',
        });

        assert.equal(callbackResponse.status, 303);
        assert.equal(callbackResponse.headers.get('location'), '/apps/basic-auth-tool');
        assert.equal(sawTokenRequest, true);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
