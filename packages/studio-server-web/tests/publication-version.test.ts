import assert from 'node:assert/strict';
import test from 'node:test';

import { isNextPublicationVersion, isPublicationVersion } from '../dashboard/publicationVersion';

test('publication versions accept only canonical nonnegative decimal strings', () => {
  for (const valid of ['0', '1', '999999999999999999999999']) assert.equal(isPublicationVersion(valid), true);
  for (const invalid of ['', '01', '-1', '+1', '1.0', ' 1', 1, null]) assert.equal(isPublicationVersion(invalid), false);
});

test('a successful publication response must advance exactly one version', () => {
  assert.equal(isNextPublicationVersion('0', '1'), true);
  assert.equal(isNextPublicationVersion('999999999999999999999999', '1000000000000000000000000'), true);
  for (const invalid of ['0', '2', '-1', 'garbage', undefined]) {
    assert.equal(isNextPublicationVersion('0', invalid), false);
  }
});
