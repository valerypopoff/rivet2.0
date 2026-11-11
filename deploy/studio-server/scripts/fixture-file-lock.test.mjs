import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireFixtureFileLock } from './fixtures/fixture-file-lock.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// test-style: fixture-read: Read only generated clock snapshots in the owned temporary fixture directory.
test('deployment fixture clock readers retain a complete snapshot while the next value is written', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-fixture-clock-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('rivet-fixture-clock-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const clockFile = path.join(directory, 'clock-offset.json');
  await fs.writeFile(clockFile, '0');
  const entry = path.join(directory, 'deploy-kubernetes-release.mjs');
  await fs.writeFile(
    entry,
    `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const clock = ${JSON.stringify(clockFile)};
    const original = fs.writeFileSync;
    let observed = 0;
    fs.writeFileSync = (file, data, ...options) => {
      if (!String(file).startsWith(clock)) return original(file, data, ...options);
      const handle = fs.openSync(file, 'w');
      try {
        // Observe exactly after truncation and before bytes become visible.
        assert.equal(JSON.parse(fs.readFileSync(clock, 'utf8')), 0);
        observed++;
        fs.writeSync(handle, data);
      } finally { fs.closeSync(handle); }
    };
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(observed, 1);
    assert.equal(JSON.parse(fs.readFileSync(clock, 'utf8')), 5000);
    console.log('Complete clock snapshot preserved.');
  `,
  );
  const output = execFileSync(
    process.execPath,
    ['--import', new URL('./fixtures/deployment-command-preload.mjs', import.meta.url).href, entry],
    {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, RIVET_COMMAND_FIXTURE: directory },
    },
  );
  assert.match(output, /Complete clock snapshot preserved/);
});

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

test('Windows delete-pending lock can disappear between open and stat without a false permission failure', () => {
  let attempts = 0,
    clock = 0;
  const io = {
    openSync() {
      if (++attempts < 3) throw Object.assign(Error('delete pending'), { code: 'EPERM' });
      return 11;
    },
    lstatSync() {
      throw Object.assign(Error('gone'), { code: 'ENOENT' });
    },
  };
  assert.equal(
    acquireFixtureFileLock('private-fixture-lock', {
      io,
      platform: 'win32',
      now: () => clock,
      wait: () => {
        clock += 10;
      },
    }),
    11,
  );
  assert.equal(attempts, 3);
});
