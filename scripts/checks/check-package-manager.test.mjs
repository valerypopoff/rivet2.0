import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePackageManagerUserAgent } from './check-package-manager.mjs';

test('allows the repository-pinned Yarn package manager', () => {
  assert.deepEqual(validatePackageManagerUserAgent('yarn/4.17.1 npm/? node/v24.0.0 win32 x64'), { ok: true });
});

test('rejects npm dependency installation with actionable Yarn instructions', () => {
  const result = validatePackageManagerUserAgent('npm/11.5.1 node/v24.0.0 win32 x64');

  assert.equal(result.ok, false);
  assert.match(result.message, /corepack enable/);
  assert.match(result.message, /yarn install --immutable/);
});

test('rejects pnpm dependency installation', () => {
  assert.equal(validatePackageManagerUserAgent('pnpm/10.18.3 npm/? node/v24.0.0 win32 x64').ok, false);
});

test('does not block non-install invocation without a package-manager user agent', () => {
  assert.deepEqual(validatePackageManagerUserAgent(undefined), { ok: true });
});
