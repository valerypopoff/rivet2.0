import test from 'node:test';
import assert from 'node:assert/strict';
import { canRefreshDevelopmentWorkspace } from '../dashboard/developmentRefreshGuard';
import { beginDevelopmentCommand, hasDevelopmentCommands } from '../dashboard/developmentActivity';

test('automatic refresh requires a clean, quiet, durably recoverable workspace', () => {
  const safe = { dirty: false, busy: false, recoverySaved: true, reloadAvailable: true };
  assert.equal(canRefreshDevelopmentWorkspace(safe), true);
  for (const key of Object.keys(safe) as Array<keyof typeof safe>) {
    assert.equal(canRefreshDevelopmentWorkspace({ ...safe, [key]: !safe[key] }), false, key);
  }
});
test('queued activity blocks refresh until all commands settle, with idempotent cleanup', () => {
  const first = beginDevelopmentCommand();
  const second = beginDevelopmentCommand();
  assert.equal(hasDevelopmentCommands(), true);
  first();
  first();
  assert.equal(hasDevelopmentCommands(), true);
  second();
  assert.equal(hasDevelopmentCommands(), false);
});
