import test from 'node:test';
// test-style: fixture-read: reads only ownership records created by these tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acquireContainerLauncher, findLegacyContainerLaunchers } from './lib/container-launcher-owner.mjs';
import { containerServerConfig, containerStorageIdentity } from './lib/container-server-config.mjs';
import { parseEnvFile } from './lib/env.mjs';
import { ensureContainerStateDirectory } from './lib/container-server-files.mjs';

const options = { stage: 'dev', identity: 'test-storage', restart: true, pollMs: 5, timeoutMs: 2000, onWait() {} };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-launcher-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function record(directory, value) {
  const owner = { version: 1, token: randomUUID(), pid: process.pid, host: os.hostname(), ...options, ...value };
  delete owner.onWait;
  const guard = path.join(directory, 'launcher.owner');
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, `owner-${owner.token}.json`), JSON.stringify(owner));
  return owner;
}
const legacy = (directory) => path.join(directory, 'launcher.lock');
const current = (directory) => JSON.parse(fs.readFileSync(legacy(directory), 'utf8'));

test('ownership is recorded, released without leftovers and release is idempotent', async (t) => {
  const directory = fixture(t);
  const release = await acquireContainerLauncher(directory, options);
  assert.equal(current(directory).pid, process.pid);
  assert.equal(current(directory).stage, 'dev');
  assert.equal(current(directory).identity, options.identity);
  release();
  release();
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a repeated dev command waits for the live owner and an old release cannot remove its successor', async (t) => {
  const directory = fixture(t);
  const releaseFirst = await acquireContainerLauncher(directory, options);
  const first = current(directory);
  let waits = 0;
  const releaseSecond = await acquireContainerLauncher(directory, {
    ...options,
    onWait() {
      waits++;
      assert.equal(current(directory).token, first.token);
      releaseFirst();
    },
  });
  const second = current(directory);
  assert.equal(waits, 1);
  assert.notEqual(first.token, second.token);
  releaseFirst();
  assert.equal(current(directory).token, second.token);
  releaseSecond();
});

test('a dead owner and its compatibility record are reclaimed automatically', async (t) => {
  const directory = fixture(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const deadPid = child.pid;
  await once(child, 'exit');
  const old = record(directory, { pid: deadPid });
  fs.writeFileSync(legacy(directory), JSON.stringify(old));
  const release = await acquireContainerLauncher(directory, options);
  assert.notEqual(current(directory).token, old.token);
  release();
});

test('an empty legacy lock is recovered only after checking for old launchers', async (t) => {
  const directory = fixture(t);
  fs.writeFileSync(legacy(directory), '');
  let checked = 0;
  const release = await acquireContainerLauncher(directory, {
    ...options,
    findLegacyOwners: async () => {
      checked++;
      return [];
    },
  });
  assert.equal(checked, 1);
  assert.equal(current(directory).pid, process.pid);
  release();
});

test('legacy live owners are awaited without unlinking their lock', async (t) => {
  const directory = fixture(t);
  fs.writeFileSync(legacy(directory), '');
  let running = true;
  const release = await acquireContainerLauncher(directory, {
    ...options,
    findLegacyOwners: async () => (running ? [123] : []),
    onWait() {
      assert.equal(fs.readFileSync(legacy(directory), 'utf8'), '');
      running = false;
      fs.unlinkSync(legacy(directory));
    },
  });
  release();
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('unknown legacy-owner status preserves its lock and releases new admission', async (t) => {
  const directory = fixture(t);
  fs.writeFileSync(legacy(directory), '');
  await assert.rejects(
    acquireContainerLauncher(directory, {
      ...options,
      findLegacyOwners: async () => {
        throw new Error('Process inventory unavailable');
      },
    }),
    /Process inventory unavailable/,
  );
  assert.deepEqual(fs.readdirSync(directory), ['launcher.lock']);
});

for (const changed of [{ host: 'another-host' }, { stage: 'prod' }, { identity: 'another-storage' }])
  test(`a foreign owner is preserved (${Object.keys(changed)[0]})`, async (t) => {
    const directory = fixture(t);
    const owner = record(directory, changed);
    await assert.rejects(acquireContainerLauncher(directory, options), /another host, stage or storage/);
    assert.ok(fs.existsSync(path.join(directory, 'launcher.owner', `owner-${owner.token}.json`)));
  });

test('staging and production do not automatically replace existing ownership', async (t) => {
  for (const stage of ['staging', 'prod']) {
    const directory = fixture(t);
    const settings = { ...options, stage, restart: false };
    const release = await acquireContainerLauncher(directory, settings);
    const owner = current(directory);
    await assert.rejects(acquireContainerLauncher(directory, settings), /already has a launcher owner/);
    assert.deepEqual(current(directory), owner);
    release();
    fs.writeFileSync(legacy(directory), '');
    await assert.rejects(acquireContainerLauncher(directory, settings), /already has a launcher owner/);
    assert.deepEqual(fs.readdirSync(directory), ['launcher.lock']);
  }
});

test('a timeout preserves the running owner', async (t) => {
  const directory = fixture(t);
  const release = await acquireContainerLauncher(directory, options);
  const owner = current(directory);
  await assert.rejects(acquireContainerLauncher(directory, { ...options, timeoutMs: 20 }), /Timed out waiting/);
  assert.deepEqual(current(directory), owner);
  release();
});

test('an empty owner directory left by interrupted cleanup can be recovered', async (t) => {
  const directory = fixture(t);
  fs.mkdirSync(path.join(directory, 'launcher.owner'));
  const release = await acquireContainerLauncher(directory, options);
  release();
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('corrupt and linked owner records are not deleted', async (t) => {
  const directory = fixture(t);
  const owner = record(directory);
  fs.writeFileSync(path.join(directory, 'launcher.owner', `owner-${owner.token}.json`), '{invalid');
  await assert.rejects(acquireContainerLauncher(directory, options), /owner record is invalid/);
  const linked = fixture(t);
  fs.symlinkSync(
    path.join(directory, 'launcher.owner'),
    path.join(linked, 'launcher.owner'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(acquireContainerLauncher(linked, options), /ordinary directory/);
  assert.ok(fs.existsSync(path.join(directory, 'launcher.owner', `owner-${owner.token}.json`)));
});

test('legacy discovery finds an actual launcher process and excludes the caller', async (t) => {
  const directory = fixture(t);
  const script = path.join(directory, 'container-server.mjs');
  fs.writeFileSync(script, 'console.log("ready"); setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await once(child.stdout, 'data');
  const owners = await findLegacyContainerLaunchers();
  assert.ok(owners.includes(child.pid));
  assert.ok(!owners.includes(process.pid));
});

test('competing launcher processes enter their critical sections one at a time', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-launcher-owner-'));
  const children = [];
  t.after(async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        }
      }),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const events = path.join(directory, 'events');
  const script = path.join(directory, 'worker.mjs');
  fs.writeFileSync(
    script,
    `
    import fs from 'node:fs';
    import { acquireContainerLauncher } from ${JSON.stringify(new URL('./lib/container-launcher-owner.mjs', import.meta.url).href)};
    const release = await acquireContainerLauncher(process.argv[2], {
      stage: 'dev', identity: 'test-storage', restart: true, timeoutMs: 5000, pollMs: 5, onWait() {},
    });
    try {
      fs.appendFileSync(process.argv[3], 'start:' + process.pid + '\\n');
      await new Promise(resolve => setTimeout(resolve, 30));
      fs.appendFileSync(process.argv[3], 'end:' + process.pid + '\\n');
    } finally { release(); }
  `,
  );
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      const child = spawn(process.execPath, [script, directory, events], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, stderr);
    }),
  );
  const lines = fs.readFileSync(events, 'utf8').trim().split('\n');
  assert.equal(lines.length, 12);
  for (let index = 0; index < lines.length; index += 2)
    assert.equal(lines[index + 1], lines[index].replace('start:', 'end:'));
});

test('the real dev CLI recovers a crashed owner without calling Docker in config mode', async (t) => {
  const directory = fixture(t);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const project = 'rivet-owner-' + randomUUID().replaceAll('-', '').slice(0, 20);
  const envFile = path.join(directory, '.env');
  fs.writeFileSync(
    envFile,
    [
      'RIVET_KEY=' + 'fixture-key-'.repeat(4),
      'RIVET_LOCAL_POSTGRES_PASSWORD=fixture-postgres-password',
      'RIVET_LOCAL_S3_ACCESS_KEY_ID=fixture-user',
      'RIVET_LOCAL_S3_SECRET_ACCESS_KEY=fixture-minio-password',
      'RIVET_DEV_COMPOSE_PROJECT=' + project,
    ].join('\n'),
  );
  const config = containerServerConfig(parseEnvFile(envFile), 'dev', 'local-storage', root);
  const state = ensureContainerStateDirectory(root, project);
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const pid = dead.pid;
  await once(dead, 'exit');
  fs.writeFileSync(
    legacy(state),
    JSON.stringify({
      version: 1,
      token: randomUUID(),
      pid,
      host: os.hostname(),
      stage: 'dev',
      identity: containerStorageIdentity(config),
    }),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(root, 'deploy/studio-server/scripts/container-server.mjs'), 'dev', 'local-storage', '--config'],
    {
      cwd: root,
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        RIVET_ENV_FILE: envFile,
        RIVET_K8S_DOCKER_BIN: path.join(directory, 'docker-must-not-run'),
      },
    },
  );
  assert.match(stdout, /Validated dev\/local-storage/);
  assert.deepEqual(fs.readdirSync(state), []);
});
