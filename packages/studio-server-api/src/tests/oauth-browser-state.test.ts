import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Request } from 'express';
import test from 'node:test';
import {
  createOAuthCookie,
  readOAuthCookie,
  readSignedOAuthPayload,
  signOAuthPayload,
  type ExpiringOAuthPayload,
} from '../oauth-browser-state.js';

const secret = () => 'fixture-session-v1';
const baselinePayload = {
  email: 'admin@example.test',
  expiresAt: 4102444800000,
  settingsVersion: 'h9IPrLS4e6Fis-YPXT-Sufe0fIpcaGM3Emuq5aTOCbo',
};
// Synthetic wire value accepted by the unmodified baseline, not an implementation-generated expected value.
const baselineToken =
  'eyJlbWFpbCI6ImFkbWluQGV4YW1wbGUudGVzdCIsImV4cGlyZXNBdCI6NDEwMjQ0NDgwMDAwMCwic2V0dGluZ3NWZXJzaW9uIjoiaDlJUHJMUzRlNkZpcy1ZUFhULVN1ZmUwZklwY2FHTTNFbXVxNWFUT0NibyJ9.JNQh6melTSl-IcIxaQmNfyjX_sfb1AGufDw1c-pUCgI';

test('signed payload writers and readers preserve the baseline wire value', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  assert.equal(signOAuthPayload(baselinePayload, secret), baselineToken);
  assert.deepEqual(readSignedOAuthPayload(baselineToken, secret), baselinePayload);
});

test('expiry uses the original strict comparison and numeric coercion', (t) => {
  t.mock.method(Date, 'now', () => 1000);
  for (const [expiresAt, accepted] of [
    [1001, true],
    [1000, false],
    [999, false],
    ['1001', true],
    ['Infinity', true],
    ['invalid', false],
  ]) {
    const payload = { expiresAt } as ExpiringOAuthPayload;
    assert.deepEqual(readSignedOAuthPayload(signOAuthPayload(payload, secret), secret), accepted ? payload : null);
  }
});

test('invalid delimiters bypass secret lookup while signature and JSON failures do not', () => {
  let reads = 0;
  const resolve = () => {
    reads++;
    return secret();
  };
  for (const value of [null, '', 'missing-dot', '.signature', 'payload.'])
    assert.equal(readSignedOAuthPayload(value, resolve), null);
  assert.equal(reads, 0);
  for (const value of [baselineToken.replace(/.$/, 'A'), `${baselineToken}x`, 'payload.signature']) {
    assert.equal(readSignedOAuthPayload(value, resolve), null);
  }
  assert.equal(reads, 3);
  const invalidJson = Buffer.from('{broken').toString('base64url');
  const signedInvalidJson = `${invalidJson}.${createHmac('sha256', secret()).update(invalidJson).digest('base64url')}`;
  assert.equal(readSignedOAuthPayload(signedInvalidJson, resolve), null);
  assert.equal(reads, 4);
  assert.equal(
    readSignedOAuthPayload(baselineToken, () => {
      throw Error('secret unavailable');
    }),
    null,
  );
});

test('signing preserves serialization-before-secret ordering and propagates failures', () => {
  let reads = 0;
  const payload: ExpiringOAuthPayload = { expiresAt: 1000 };
  payload.circular = payload;
  assert.throws(
    () =>
      signOAuthPayload(payload, () => {
        reads++;
        return secret();
      }),
    TypeError,
  );
  assert.equal(reads, 0);
  assert.throws(
    () =>
      signOAuthPayload(baselinePayload, () => {
        throw Error('secret unavailable');
      }),
    /secret unavailable/,
  );
});

test('cookie readers preserve Express/IncomingMessage arrays, first matches and embedded equals', () => {
  const header = 'unrelated; target=A==; target=second; other=value';
  const expressRequest = { get: () => header } as unknown as Request;
  const incoming = {
    headers: { cookie: ['other=value', ' target=A== ', 'target=second'] },
  } as unknown as IncomingMessage;
  assert.equal(readOAuthCookie(expressRequest, 'target'), 'A==');
  assert.equal(readOAuthCookie(incoming, 'target'), 'A==');
  assert.equal(readOAuthCookie(incoming, 'missing'), null);
  assert.equal(readOAuthCookie({ headers: {} } as IncomingMessage, 'target'), null);
});

test('cookie creation and clearing preserve the historical Secure punctuation', () => {
  assert.equal(
    createOAuthCookie('example', 'A==', 600, ''),
    'example=A==; Path=/; HttpOnly; SameSite=Lax; Max-Age=600',
  );
  assert.equal(
    createOAuthCookie('example', 'A==', 600, '; Secure'),
    'example=A==; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; ; Secure',
  );
  assert.equal(
    createOAuthCookie('example', '', 0, '; Secure'),
    'example=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; ; Secure',
  );
});
