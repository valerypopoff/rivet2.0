import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createActiveHttpExecutionRegistry } from '../active-http-executions.js';

void test('active HTTP executions are aborted at the drain deadline and late registrations fail closed', () => {
  const registry = createActiveHttpExecutionRegistry();
  const accepted = registry.register();

  assert.equal(accepted.signal.aborted, false);
  assert.equal(registry.getActiveCount(), 1);

  registry.beginDrain();
  const late = registry.register();
  assert.equal(late.signal.aborted, true);
  assert.equal(registry.getActiveCount(), 2);

  const reason = new Error('shutdown deadline reached');
  assert.equal(registry.abortActive(reason), 1);
  assert.equal(accepted.signal.aborted, true);
  assert.equal(accepted.signal.reason, reason);
  assert.equal(registry.abortActive(reason), 0);

  accepted.release();
  accepted.release();
  late.release();
  assert.equal(registry.getActiveCount(), 0);
});