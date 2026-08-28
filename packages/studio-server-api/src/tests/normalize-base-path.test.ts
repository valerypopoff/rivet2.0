import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBasePathFromAliases } from '../../../studio-server-shared/normalize-base-path.js';

test('base path aliases prefer the first configured value before legacy defaults', () => {
  assert.equal(
    normalizeBasePathFromAliases(['/published-apps', '/apps'], '/apps'),
    '/published-apps',
  );
  assert.equal(
    normalizeBasePathFromAliases(['', 'legacy-apps'], '/apps'),
    '/legacy-apps',
  );
  assert.equal(
    normalizeBasePathFromAliases([undefined, ''], '/apps'),
    '/apps',
  );
});
