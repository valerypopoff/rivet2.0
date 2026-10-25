import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireFixtureFileLock } from './fixtures/fixture-file-lock.mjs';

test('fixture lock bounds Windows contention without hiding permissions, links or stealing locks', () => {
  for (const code of ['EEXIST', 'EPERM']) {
    let attempts = 0,
      clock = 0;
    const io = {
      openSync: () => {
        if (++attempts < 3) throw Object.assign(Error('busy'), { code });
        return 9;
      },
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    };
    const options = {
      io,
      platform: 'win32',
      now: () => clock,
      wait: () => {
        clock += 10;
      },
      timeoutMs: 30,
    };
    assert.equal(acquireFixtureFileLock('owned-fixture-lock', options), 9);
    io.openSync = () => {
      throw Object.assign(Error('busy'), { code });
    };
    assert.throws(() => acquireFixtureFileLock('owned-fixture-lock', options), /Timed out/);
    io.lstatSync = () => ({ isFile: () => false, isSymbolicLink: () => true });
    assert.throws(() => acquireFixtureFileLock('owned-fixture-lock', options), /Unsafe/);
  }
  const denied = Object.assign(Error('denied'), { code: 'EPERM' });
  for (const platform of ['linux', 'win32']) {
    const io = {
      openSync() {
        throw denied;
      },
      lstatSync() {
        throw Object.assign(Error('absent'), { code: 'ENOENT' });
      },
    };
    assert.throws(
      () => acquireFixtureFileLock('owned-fixture-lock', { io, platform }),
      (error) => error === denied,
    );
  }
});
