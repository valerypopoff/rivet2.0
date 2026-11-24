import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isNextPublicationVersion,
  isPublicationVersion,
  isUnconfirmedPublication,
} from '../dashboard/publicationVersion';

void test('publication versions accept only canonical nonnegative decimal strings', () => {
  for (const valid of ['0', '1', '999999999999999999999999']) assert.equal(isPublicationVersion(valid), true);
  for (const invalid of ['', '01', '-1', '+1', '1.0', ' 1', 1, null])
    assert.equal(isPublicationVersion(invalid), false);
});

void test('a successful publication response must advance exactly one version', () => {
  assert.equal(isNextPublicationVersion('0', '1'), true);
  assert.equal(isNextPublicationVersion('999999999999999999999999', '1000000000000000000000000'), true);
  for (const invalid of ['0', '2', '-1', 'garbage', undefined]) {
    assert.equal(isNextPublicationVersion('0', invalid), false);
  }
  for (const [previous, next] of [
    ['', '1'],
    ['00', '1'],
    ['01', '2'],
    ['-1', '0'],
    ['+0', '1'],
    [' 0', '1'],
  ] as const) {
    assert.equal(isNextPublicationVersion(previous, next), false);
  }
});

void test('unconfirmed publication outcomes include transport failures, unreadable success, timeout and server errors', () => {
  for (const error of [null, new Error('Connection lost'), {}, { status: '500' }]) {
    assert.equal(isUnconfirmedPublication(error), true);
  }
  for (const status of [200, 399, 408, 500, 503]) assert.equal(isUnconfirmedPublication({ status }), true);
  for (const status of [400, 401, 403, 404, 407, 409, 422, 499]) {
    assert.equal(isUnconfirmedPublication({ status }), false);
  }
});
