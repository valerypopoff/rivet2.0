import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompilerOwner } from './compiler-owner.mjs';

test('builder failure kills only its currently owned compiler, exactly once', () => {
  const killed = [];
  const owner = createCompilerOwner((pid, signal) => killed.push([pid, signal]));
  owner.track(41);
  owner.forget(40); // a late exit from an older compiler cannot clear its replacement
  owner.stop();
  owner.stop();
  assert.deepEqual(killed, [[41, 'SIGKILL']]);
  owner.track(42);
  owner.forget(42);
  owner.stop();
  assert.equal(killed.length, 1);
  for (const invalid of [null, 0, 1, -10, 1.5, '43']) owner.track(invalid);
  owner.stop();
  assert.equal(killed.length, 1);
});

test('an already exited compiler is harmless; unexpected kill errors are not hidden', () => {
  const missing = createCompilerOwner(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  missing.track(41);
  assert.doesNotThrow(() => missing.stop());
  const denied = createCompilerOwner(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  denied.track(42);
  assert.throws(() => denied.stop(), /denied/);
});
