import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localUpgradeFailure } from '../local-metadata/upgrade-diagnostics.js';

test('upgrade diagnostics classify only fixed error codes without serializing secret error content', () => {
  for (const [code, expected] of [
    ['ENOSPC', 'disk-full'],
    ['EDQUOT', 'disk-full'],
    ['EACCES', 'permission-denied'],
    ['EROFS', 'permission-denied'],
    ['ENOENT', 'missing-data'],
    ['EIO', 'io-error'],
  ]) {
    const error = Object.assign(new Error('secret-password-path-SQL-input'), { code, cause: 'private' });
    assert.deepEqual(localUpgradeFailure('settings', error), { stage: 'settings', code: expected });
  }
  const hostile = {
    get code(): never {
      throw new Error('private');
    },
  };
  assert.deepEqual(localUpgradeFailure('certification', hostile), {
    stage: 'certification',
    code: 'verification-failed',
  });
  assert.deepEqual(localUpgradeFailure('settings', { code: 'secret-password-path' }), {
    stage: 'settings',
    code: 'invalid-data',
  });
});
