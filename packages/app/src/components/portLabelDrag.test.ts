import assert from 'node:assert/strict';
import test from 'node:test';

import { canStartWireDragFromPortLabel, isPrimaryPortMouseButton } from './Port.js';

test('canStartWireDragFromPortLabel only allows wire starts from output labels', () => {
  assert.equal(canStartWireDragFromPortLabel(false), true);
  assert.equal(canStartWireDragFromPortLabel(true), false);
});

test('port mouse gestures only use the primary mouse button', () => {
  assert.equal(isPrimaryPortMouseButton(0), true);
  assert.equal(isPrimaryPortMouseButton(1), false);
  assert.equal(isPrimaryPortMouseButton(2), false);
});
