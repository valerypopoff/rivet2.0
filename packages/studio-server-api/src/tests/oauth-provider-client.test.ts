import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readOAuthAccessToken,
  readOAuthProfileEmail,
  readOAuthProviderJsonResponse,
} from '../oauth-provider-client.js';

test('provider JSON validation retains status, malformed-body and object-only behavior', async () => {
  assert.deepEqual(await readOAuthProviderJsonResponse(new Response('{"value":1}'), 'profile request'), { value: 1 });
  for (const response of [
    new Response('{}', { status: 503 }),
    new Response('invalid JSON'),
    new Response('[]'),
    new Response('null'),
    new Response('"email"'),
    new Response('1'),
    new Response('true'),
  ]) {
    await assert.rejects(readOAuthProviderJsonResponse(response, 'token exchange'), {
      status: 401,
      message: 'OAuth token exchange failed',
    });
  }
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(Error('disconnected body'));
      },
    }),
  );
  await assert.rejects(readOAuthProviderJsonResponse(broken, 'profile request'), {
    status: 401,
    message: 'OAuth profile request failed',
  });
});

test('access tokens preserve nonempty strings without trimming or coercion', () => {
  assert.equal(readOAuthAccessToken({ access_token: '  token  ' }), '  token  ');
  assert.equal(readOAuthAccessToken({ access_token: ' ' }), ' ');
  for (const access_token of [undefined, null, '', 123]) {
    assert.throws(() => readOAuthAccessToken({ access_token }), {
      status: 401,
      message: 'OAuth token response did not include an access token',
    });
  }
});

test('email claims preserve dotted traversal, normalization and missing-claim errors', () => {
  assert.equal(
    readOAuthProfileEmail({ account: { email: ' User@Example.Test ' } }, 'account.email'),
    'user@example.test',
  );
  assert.equal(
    readOAuthProfileEmail({ accounts: [{ email: 'user@example.test' }] }, 'accounts.0.email'),
    'user@example.test',
  );
  for (const profile of [{}, { account: null }, { account: { email: 123 } }, { account: { email: '  ' } }]) {
    assert.throws(() => readOAuthProfileEmail(profile, 'account.email'), {
      status: 401,
      message: 'OAuth profile did not include account.email',
    });
  }
});
