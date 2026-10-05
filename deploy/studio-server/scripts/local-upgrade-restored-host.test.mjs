import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { restoredHostFixtureArgs } from './local-upgrade-restored-host.integration.mjs';
import { createRestoredContainerTracker } from './local-upgrade-restored-rehearsal.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'sha256:' + 'a'.repeat(64);
const volume = 'rivet-restored-host-fixture-data';
const mounts = (args) => args.flatMap((value, index) => (value === '--mount' ? [args[index + 1]] : []));

test('host fixture mounts all backup dependencies read-only with their deployment-relative paths', () => {
  const args = restoredHostFixtureArgs(image, volume);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'node');
  assert.equal(args[args.indexOf('--entrypoint') + 2], image);
  assert.deepEqual(mounts(args), [
    `type=volume,source=${volume},target=/fixture`,
    ...[
      'scripts/local-upgrade-backup.mjs',
      'scripts/local-upgrade-snapshot-plan.mjs',
      'images/api/local-upgrade-ui.mjs',
    ].map((file) => `type=bind,source=${path.join(root, 'deploy/studio-server', file)},target=/tools/${file},readonly`),
  ]);
});

test('the actual host mount plan imports the backup module in an otherwise empty filesystem', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-host-tools-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  try {
    for (const mount of mounts(restoredHostFixtureArgs(image, volume)).filter((mount) =>
      mount.startsWith('type=bind,'),
    )) {
      const parts = Object.fromEntries(mount.split(',').map((part) => part.split('=')));
      assert.ok(mount.endsWith(',readonly'));
      const destination = path.join(directory, parts.target.slice(1));
      assert.ok(destination.startsWith(directory + path.sep));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(parts.source, destination);
    }
    const backup = pathToFileURL(path.join(directory, 'tools/scripts/local-upgrade-backup.mjs')).href;
    const command = ['--input-type=module', '-e', `await import(${JSON.stringify(backup)});`];
    await exec(process.execPath, command, { windowsHide: true, timeout: 30_000 });
    await fs.unlink(path.join(directory, 'tools/images/api/local-upgrade-ui.mjs'));
    await assert.rejects(exec(process.execPath, command, { windowsHide: true, timeout: 30_000 }), (error) => {
      assert.match(error.stderr, /ERR_MODULE_NOT_FOUND/);
      return true;
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test(
  'host fixture creates a real checksummed backup using its exact Docker command',
  { skip: !process.env.RIVET_REHEARSAL_API_IMAGE, timeout: 120_000 },
  async () => {
    const docker = (args) => exec('docker', args, { windowsHide: true, timeout: 90_000, maxBuffer: 1048576 });
    const imageId = JSON.parse((await docker(['image', 'inspect', process.env.RIVET_REHEARSAL_API_IMAGE])).stdout)[0]
      .Id;
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const owner = 'rivet-restored-host-test-' + randomUUID();
    const ownedVolume = owner + '-data';
    const tracker = createRestoredContainerTracker(docker, owner);
    let created = false;
    try {
      assert.equal(
        (await docker(['volume', 'ls', '--filter', `name=^${ownedVolume}$`, '--format', '{{.Name}}'])).stdout.trim(),
        '',
      );
      await docker(['volume', 'create', '--label', `rivet.local-upgrade.restored=${owner}`, ownedVolume]);
      created = true;
      await tracker.start(restoredHostFixtureArgs(imageId, ownedVolume));
      assert.equal((await docker(['wait', owner])).stdout.trim(), '0', 'Host fixture generation failed.');
      const logs = (await docker(['logs', owner])).stdout;
      const result = JSON.parse(logs.split(/\r?\n/).find((line) => line.startsWith('{')));
      assert.match(result.receipt, /^[a-f0-9]{64}$/);
    } finally {
      assert.equal((await tracker.cleanup(true)).failed, false, 'Owned fixture cleanup failed.');
      if (created) {
        const info = JSON.parse((await docker(['volume', 'inspect', ownedVolume])).stdout)[0];
        assert.equal(info.Labels?.['rivet.local-upgrade.restored'], owner);
        await docker(['volume', 'rm', ownedVolume]);
      }
    }
  },
);
