import assert from 'node:assert/strict';
import test from 'node:test';
import { getPromoRootMode } from './promoRoot.js';

test('promo root mounts the detached web-app preview only for its preview URL', () => {
  assert.equal(getPromoRootMode('?rivet-web-app-preview=preview-token'), 'web-app-preview');
  assert.equal(getPromoRootMode('?project=web-app'), 'editor');
  assert.equal(getPromoRootMode(''), 'editor');
});
