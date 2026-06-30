import http from 'node:http';
import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';

import {
  createWebAppOAuthAuthorizationRedirect,
  getWebAppAuthMode,
  isWebAppOAuthSessionAllowed,
  readWebAppOAuthSession,
  webAppOAuthRouter,
  type WebAppOAuthSession,
} from '../web-app-oauth.js';

type MockRequest = {
  protocol?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string>;
  get(name: string): string | undefined;
};

const OAUTH_ENV_KEYS = [
  'RIVET_WEB_APPS_AUTH_MODE',
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

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of OAUTH_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  try {
    for (const key of OAUTH_ENV_KEYS) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(values)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function getCookieValue(setCookieHeader: string, name: string): string {
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `Expected ${name} cookie`);
  return match[1]!;
}

async function withOAuthCallbackServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use('/', webAppOAuthRouter);
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
      createMockRequest({ host: 'rivet.example.test', 'x-forwarded-proto': 'https' }) as any,
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

test('web app OAuth redirect uses forwarded host when no explicit callback URL is configured', async () => {
  await withEnv({
    OAUTH_AUTHORIZE_URL: 'https://oauth.example.test/authorize',
    OAUTH_TOKEN_URL: 'https://oauth.example.test/token',
    OAUTH_USER_URL: 'https://oauth.example.test/profile',
    OAUTH_CLIENT_ID: 'client-id',
    OAUTH_CLIENT_SECRET: 'client-secret',
  }, () => {
    const redirect = createWebAppOAuthAuthorizationRedirect(
      createMockRequest({
        host: 'api.internal:80',
        'x-forwarded-host': 'rivet.example.test',
        'x-forwarded-proto': 'https',
      }) as any,
      '/apps/my-tool',
    );
    const location = new URL(redirect.location);
    assert.equal(location.searchParams.get('redirect_uri'), 'https://rivet.example.test/apps/auth/callback');
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
        assert.equal(isWebAppOAuthSessionAllowed(session, []), true);
        assert.equal(isWebAppOAuthSessionAllowed(session, ['USER@example.com']), true);
        assert.equal(isWebAppOAuthSessionAllowed(session, ['other@example.com']), false);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
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
