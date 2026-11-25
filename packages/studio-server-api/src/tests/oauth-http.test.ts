import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import {
  startOAuthHttpFixture,
  oauthCallback,
  oauthCookie,
  type OAuthProviderRequest,
  type OAuthRedirect,
  type OAuthStatus,
} from './helpers/oauth-http-fixture.js';

let fixture: Awaited<ReturnType<typeof startOAuthHttpFixture>>;
test.before(async () => {
  fixture = await startOAuthHttpFixture();
});
test.beforeEach(async () => {
  await fixture.command('reset');
});
test.after(async () => {
  if (fixture) {
    await Promise.all([fixture.close(), fixture.close()]);
    await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
  }
});
const stateName = (surface: 'ui' | 'visitor') =>
  surface === 'ui' ? 'rivet_ui_oauth_state' : 'rivet_web_app_oauth_state';
const sessionName = (surface: 'ui' | 'visitor') =>
  surface === 'ui' ? 'rivet_ui_oauth_session' : 'rivet_web_app_oauth_session';

function request(url: string, options: RequestInit = {}) {
  return fetch(new URL(url, fixture.baseUrl), { ...options, signal: AbortSignal.timeout(15_000) });
}

function decodePayload(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function callback(surface: 'ui' | 'visitor', email = 'admin@example.test', redirect?: OAuthRedirect) {
  const authorization = redirect ?? (await fixture.command<OAuthRedirect>('start', { surface }));
  const response = await request(oauthCallback(fixture.baseUrl, surface, authorization, email), {
    headers: { cookie: oauthCookie(authorization.cookies, stateName(surface)) },
    redirect: 'manual',
  });
  await response.text();
  return response;
}

for (const surface of ['ui', 'visitor'] as const) {
  test(`${surface} mounted callback preserves body/basic exchange, cookies and normalized identity`, async () => {
    for (const clientAuthMethod of ['body', 'basic']) {
      await fixture.command('reset');
      await fixture.command('configure', { clientAuthMethod });
      const email = surface === 'ui' ? ' Admin@Example.Test ' : ' Visitor@Example.Test ';
      const code = Buffer.from(email).toString('base64url');
      const response = await callback(surface, email);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), `/fixture/${surface === 'ui' ? 'ui' : 'app'}`);
      assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
      const cookie = oauthCookie(response.headers.getSetCookie(), sessionName(surface));
      const status = (await (await request('/fixture/status', { headers: { cookie } })).json()) as OAuthStatus;
      assert.equal(
        surface === 'ui' ? status.uiEmail : status.visitorEmail,
        surface === 'ui' ? 'admin@example.test' : 'visitor@example.test',
      );
      assert.equal(surface === 'ui' ? status.uiAllowed : status.visitorAllowed, true);
      const requests = await fixture.command<OAuthProviderRequest[]>('requests');
      assert.deepEqual(
        requests.map((request) => [request.stage, request.method]),
        [
          ['token', 'POST'],
          ['profile', 'GET'],
        ],
      );
      const body = new URLSearchParams(requests[0]!.body);
      assert.equal(requests[0]!.contentType, 'application/x-www-form-urlencoded');
      assert.equal(requests[0]!.accept, 'application/json');
      assert.equal(requests[1]!.accept, 'application/json');
      assert.deepEqual(
        [...body],
        [
          ['grant_type', 'authorization_code'],
          ['code', code],
          [
            'redirect_uri',
            `${fixture.baseUrl}${surface === 'ui' ? '/__rivet_auth/oauth/callback' : '/apps/auth/callback'}`,
          ],
          ...(clientAuthMethod === 'body'
            ? [
                ['client_id', 'fixture-client'],
                ['client_secret', 'fixture-client-secret'],
              ]
            : []),
        ],
      );
      assert.equal(
        requests[0]!.authorization,
        clientAuthMethod === 'basic'
          ? `Basic ${Buffer.from('fixture-client:fixture-client-secret').toString('base64')}`
          : '',
      );
      assert.equal(requests[1]!.authorization, `Bearer ${code}`);
      assert.equal(requests[1]!.body, '');
    }
  });

  test(`${surface} mounted callback holds its request settings while the next request rejects its old cookie`, async () => {
    await fixture.command('hold', { stage: 'profile' });
    const redirect = await fixture.command<OAuthRedirect>('start', { surface });
    const state = decodePayload(new URL(redirect.location).searchParams.get('state')!);
    const response = callback(surface, 'admin@example.test', redirect);
    const settlement = response.catch(() => undefined);
    try {
      await fixture.command('wait-held');
      await fixture.command('configure', { sessionSecret: 'fixture-session-v2' });
    } finally {
      try {
        await fixture.command('release');
      } finally {
        await settlement;
      }
    }
    const completed = await response;
    assert.equal(completed.status, 303);
    const cookie = oauthCookie(completed.headers.getSetCookie(), sessionName(surface));
    const value = cookie.slice(cookie.indexOf('=') + 1);
    const [payload, signature] = value.split('.');
    assert.equal(signature, createHmac('sha256', 'fixture-session-v1').update(payload!).digest('base64url'));
    assert.equal(decodePayload(value).settingsVersion, state.settingsVersion);
    const status = (await (await request('/fixture/status', { headers: { cookie } })).json()) as OAuthStatus;
    assert.equal(surface === 'ui' ? status.uiEmail : status.visitorEmail, null);
    assert.deepEqual(
      (await fixture.command<OAuthProviderRequest[]>('requests')).map((request) => request.stage),
      ['token', 'profile'],
    );
  });

  test(`${surface} invalid initial state makes no provider call and preserves state clearing`, async () => {
    const response = await request(
      `${surface === 'ui' ? '/ui-auth/oauth/callback' : '/apps/auth/callback'}?code=bad&state=bad`,
      { redirect: 'manual' },
    );
    await response.text();
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?auth_error=oauth_state');
    assert.deepEqual(response.headers.getSetCookie(), [
      `${stateName(surface)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
    assert.deepEqual(await fixture.command('requests'), []);
  });

  test(`${surface} token/profile rejection preserves callback error mapping and request counts`, async () => {
    for (const [behavior, expectedCode, expectedStages] of [
      [{ tokenStatus: 503 }, 'oauth_token', ['token']],
      [{ missingToken: true }, 'oauth_token', ['token']],
      [{ disconnect: 'token' }, 'oauth_failed', ['token']],
      [{ disconnect: 'profile' }, 'oauth_failed', ['token', 'profile']],
      [{ profileStatus: 503 }, 'oauth_failed', ['token', 'profile']],
      [{ invalidJson: 'profile' }, 'oauth_failed', ['token', 'profile']],
      [{ missingEmail: true }, 'oauth_profile', ['token', 'profile']],
    ] as const) {
      await fixture.command('reset');
      await fixture.command('behavior', behavior);
      const response = await callback(surface);
      const scenario = `${surface} ${JSON.stringify(behavior)}`;
      assert.equal(response.status, 303, scenario);
      assert.equal(
        response.headers.get('location'),
        `/fixture/${surface === 'ui' ? 'ui' : 'app'}?auth_error=${expectedCode}`,
        scenario,
      );
      assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate', scenario);
      assert.deepEqual(
        response.headers.getSetCookie(),
        [`${stateName(surface)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`],
        scenario,
      );
      assert.deepEqual(
        (await fixture.command<OAuthProviderRequest[]>('requests')).map((request) => request.stage),
        expectedStages,
        scenario,
      );
    }
  });
}

test('fixture rejects an unserializable command without retaining its deadline', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const before = timers();
  await assert.rejects(fixture.command('configure', { unsupported: 1n }), TypeError);
  assert.equal(timers(), before);
  assert.deepEqual(await fixture.command('requests'), []);
});

test('fixture cleanup rejects an unexpected child exit and still removes its owned root', async () => {
  const crashed = await startOAuthHttpFixture();
  try {
    await assert.rejects(crashed.command('crash'), /OAuth fixture exited/);
    await Promise.all([
      assert.rejects(crashed.close(), /OAuth fixture exited/),
      assert.rejects(crashed.close(), /OAuth fixture exited/),
    ]);
    await assert.rejects(fs.stat(crashed.root), { code: 'ENOENT' });
  } finally {
    await crashed.close().catch(() => undefined);
  }
});

test('fixture startup failure preserves its diagnostics and removes its owned root', async () => {
  const roots = async () =>
    (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(`rivet-oauth-${process.pid}-`)).sort();
  const before = await roots();
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--oauth-fixture-invalid-option';
  try {
    await assert.rejects(startOAuthHttpFixture(), (error: Error) => {
      assert.match(error.message, /OAuth fixture startup exited/);
      assert.match(error.message, /oauth-fixture-invalid-option/);
      return true;
    });
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  }
  assert.deepEqual(await roots(), before);
});

test('UI admission follows provider reads, and OAuth revocation escapes the opening snapshot', async () => {
  const denied = await callback('ui', 'denied@example.test');
  assert.match(denied.headers.get('location')!, /oauth_forbidden$/);
  assert.equal((await fixture.command<OAuthProviderRequest[]>('requests')).length, 2);
  await fixture.command('reset');
  await fixture.command('configure', { serverUiAdminEmails: [] });
  assert.match((await callback('ui')).headers.get('location')!, /oauth_forbidden$/);
  await fixture.command('reset');
  const accepted = await callback('ui');
  await fixture.command('watch-ui', { cookie: oauthCookie(accepted.headers.getSetCookie(), sessionName('ui')) });
  assert.equal(await fixture.command('revocations'), 0);
  await fixture.command('configure', { sessionSecret: 'fixture-session-v2' });
  assert.equal(await fixture.command('revocations'), 1);
});

test('the existing state/cookie return-target comparison remains surface-specific', async () => {
  for (const surface of ['ui', 'visitor'] as const) {
    await fixture.command('reset');
    const redirect = await fixture.command<OAuthRedirect>('start', { surface });
    const state = new URL(redirect.location).searchParams.get('state')!;
    const payload = decodePayload(state);
    const changedCookie = await fixture.command<string>('sign', { payload: { ...payload, returnTo: '/different' } });
    const response = await request(oauthCallback(fixture.baseUrl, surface, redirect, 'admin@example.test'), {
      headers: { cookie: `${stateName(surface)}=${changedCookie}` },
      redirect: 'manual',
    });
    await response.text();
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), surface === 'ui' ? '/?auth_error=oauth_state' : '/fixture/app');
    assert.equal((await fixture.command<OAuthProviderRequest[]>('requests')).length, surface === 'ui' ? 0 : 2);
  }
});

test('direct token completion re-reads profile configuration after the token response', async () => {
  await fixture.command('hold', { stage: 'token' });
  const completion = assert.rejects(
    fixture.command('direct-ui', { code: Buffer.from('admin@example.test').toString('base64url') }),
    /OAuth profile did not include account.changed/,
  );
  const settlement = completion.catch(() => undefined);
  try {
    await fixture.command('wait-held');
    await fixture.command('configure', { emailClaim: 'account.changed' });
  } finally {
    try {
      await fixture.command('release');
    } finally {
      await settlement;
    }
  }
  await completion;
});

test('direct UI completion retains lookups outside a request snapshot', async () => {
  await fixture.command('hold', { stage: 'profile' });
  const completion = fixture.command<string>('direct-ui', {
    code: Buffer.from('admin@example.test').toString('base64url'),
  });
  const settlement = completion.catch(() => undefined);
  try {
    await fixture.command('wait-held');
    await fixture.command('configure', { sessionSecret: 'fixture-session-v2' });
  } finally {
    try {
      await fixture.command('release');
    } finally {
      await settlement;
    }
  }
  const cookie = oauthCookie(await completion, sessionName('ui'));
  const status = (await (await request('/fixture/status', { headers: { cookie } })).json()) as OAuthStatus;
  assert.equal(status.uiEmail, 'admin@example.test');
});

test('baseline wire receipt preserves fingerprints, synthetic sessions, surface separation and cookie bytes', async () => {
  const wire = await fixture.command<Record<string, unknown>>('wire');
  const uiPayload = {
    email: 'admin@example.test',
    expiresAt: 4102444800000,
    settingsVersion: 'h9IPrLS4e6Fis-YPXT-Sufe0fIpcaGM3Emuq5aTOCbo',
  };
  const visitorPayload = {
    email: 'visitor@example.test',
    expiresAt: 4102444800000,
    settingsVersion: 'TtVoSwqHNe-1r_giU9b5bjXdfGSU8Y8fB22S9hEH0do',
  };
  assert.equal(wire.uiVersion, uiPayload.settingsVersion);
  assert.equal(wire.visitorVersion, visitorPayload.settingsVersion);
  // Synthetic values accepted before extraction; always checked in CI without a local receipt.
  assert.equal(
    wire.uiToken,
    'eyJlbWFpbCI6ImFkbWluQGV4YW1wbGUudGVzdCIsImV4cGlyZXNBdCI6NDEwMjQ0NDgwMDAwMCwic2V0dGluZ3NWZXJzaW9uIjoiaDlJUHJMUzRlNkZpcy1ZUFhULVN1ZmUwZklwY2FHTTNFbXVxNWFUT0NibyJ9.JNQh6melTSl-IcIxaQmNfyjX_sfb1AGufDw1c-pUCgI',
  );
  assert.equal(
    wire.visitorToken,
    'eyJlbWFpbCI6InZpc2l0b3JAZXhhbXBsZS50ZXN0IiwiZXhwaXJlc0F0Ijo0MTAyNDQ0ODAwMDAwLCJzZXR0aW5nc1ZlcnNpb24iOiJUdFZvU3dxSE5lLTFyX2dpVTliNWJqWGRmR1NVOFk4ZkIyMlM5aEVIMGRvIn0.8GCv6bmeGc29paDcMTDh5r5r-1dRftLdhZnZBQ8FsKE',
  );
  assert.deepEqual(wire.uiRead, uiPayload);
  assert.deepEqual(wire.visitorRead, visitorPayload);
  assert.equal(wire.crossUi, null);
  assert.equal(wire.crossVisitor, null);
  assert.deepEqual(wire.cookies, [
    'example=A==; Path=/; HttpOnly; SameSite=Lax; Max-Age=600',
    'example=A==; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; ; Secure',
    'example=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'example=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; ; Secure',
  ]);
});
