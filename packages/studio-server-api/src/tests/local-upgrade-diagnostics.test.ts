import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LocalUpgradeDiagnosticError,
  localUpgradeFailure,
  localUpgradeSourceError,
  localUpgradeSourceReference,
} from '../local-metadata/upgrade-diagnostics.js';

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
    reason: 'unexpected-error',
  });
  assert.deepEqual(localUpgradeFailure('settings', { code: 'secret-password-path' }), {
    stage: 'settings',
    code: 'invalid-data',
    reason: 'unexpected-error',
  });
});

test('specific workflow diagnostics preserve only a reason and opaque normalized project reference', () => {
  const secret = Object.assign(new Error('password=never-return-this /private/path SELECT secret'), { code: 'EACCES' });
  const error = localUpgradeSourceError(secret, 'private/project.rivet-project', 'project-settings-invalid');
  const result = localUpgradeFailure('workflows', error);
  assert.deepEqual(result, {
    stage: 'workflows',
    code: 'permission-denied',
    reason: 'project-settings-invalid',
    sourceReference: localUpgradeSourceReference('private/project.rivet-project'),
  });
  assert.match(result.sourceReference!, /^[a-f0-9]{16}$/);
  assert.equal(localUpgradeSourceReference('private\\project.rivet-project'), result.sourceReference);
  for (const privateText of ['password', 'private', 'SELECT', 'secret'])
    assert.equal(JSON.stringify(result).includes(privateText), false);
  assert.equal(
    localUpgradeFailure(
      'workflows',
      localUpgradeSourceError(new LocalUpgradeDiagnosticError('project-id-duplicate'), 'a', 'unexpected-error'),
    ).reason,
    'project-id-duplicate',
  );
});

test('mutated diagnostic fields cannot leak content or prevent failure settlement', () => {
  const error = new LocalUpgradeDiagnosticError('project-parse-failed');
  Object.defineProperty(error, 'reason', { value: 'private source contents' });
  Object.defineProperty(error, 'sourceReference', { value: '/private/project' });
  assert.deepEqual(localUpgradeFailure('workflows', error), {
    stage: 'workflows',
    code: 'invalid-data',
    reason: 'unexpected-error',
  });
  const hostile = new LocalUpgradeDiagnosticError('project-parse-failed');
  Object.defineProperty(hostile, 'reason', {
    get() {
      throw new Error('private');
    },
  });
  assert.deepEqual(localUpgradeFailure('workflows', hostile), {
    stage: 'workflows',
    code: 'invalid-data',
    reason: 'unexpected-error',
  });
});
