import assert from 'node:assert/strict';
// test-style: fixture-read: reads the generated test-owned entrypoint and copied backup-tool fixture modules, not implementation source.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { restoredHostFixtureArgs } from './local-upgrade-restored-host.integration.mjs';
import {
  createRestoredContainerTracker,
  restoredLegacyApiMount,
  restoredReadinessProbeScript,
} from './local-upgrade-restored-rehearsal.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'sha256:' + 'a'.repeat(64);
const volume = 'rivet-restored-host-fixture-data';
const mounts = (args) => args.flatMap((value, index) => (value === '--mount' ? [args[index + 1]] : []));

test('restored-copy startup stages the shared compatibility entrypoint as an exclusive read-only fixture mount', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-restored-entrypoint-'));
  try {
    const args = await restoredLegacyApiMount(directory);
    const file = path.join(directory, 'legacy-api-entrypoint.sh');
    assert.deepEqual(args, ['--mount', `type=bind,source=${file},target=/opt/rivet/api-entrypoint.sh,readonly`]);
    const entrypoint = await fs.readFile(file, 'utf8');
    assert.match(entrypoint, /exec node .*\/server\.js/);
    assert.doesNotMatch(entrypoint, /server-deployment-contract|\/serve\.js/);
    assert.match(entrypoint, /load_optional_dotenv_preserving_deployment_storage/);
    assert.match(entrypoint, /append_proxy_bootstrap_node_options/);
    await assert.rejects(restoredLegacyApiMount(directory), { code: 'EEXIST' });
    assert.equal(await fs.readFile(file, 'utf8'), entrypoint);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

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
  'host fixture creates a checksummed backup and boots legacy compatibility without weakening production admission',
  { skip: !process.env.RIVET_REHEARSAL_API_IMAGE, timeout: 180_000 },
  async () => {
    const docker = (args) => exec('docker', args, { windowsHide: true, timeout: 90_000, maxBuffer: 1048576 });
    const imageId = JSON.parse((await docker(['image', 'inspect', process.env.RIVET_REHEARSAL_API_IMAGE])).stdout)[0]
      .Id;
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const owner = 'rivet-restored-host-test-' + randomUUID();
    const ownedVolume = owner + '-data';
    const tracker = createRestoredContainerTracker(docker, owner);
    const backendOwner = owner + '-backend';
    const backend = createRestoredContainerTracker(docker, backendOwner);
    const entrypointDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-host-entrypoint-'));
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
      await assert.rejects(
        docker([
          'run',
          '--rm',
          '--network',
          'none',
          '--env',
          'RIVET_DEPLOYMENT_TOPOLOGY=single-host',
          '--entrypoint',
          'node',
          imageId,
          '--input-type=module',
          '-e',
          "import {assertServerDeploymentContract} from '/app/packages/studio-server-api/dist/studio-server-api/src/server-deployment-contract.js'; assertServerDeploymentContract();",
        ]),
        (error) => {
          assert.match(error.stderr, /requires RIVET_DEPLOYMENT_TOPOLOGY=replicated/);
          return true;
        },
      );
      // Only this generated volume is made writable by the serving UID.
      await tracker.runTool([
        '--network',
        'none',
        '--user',
        '0',
        '--mount',
        `type=volume,source=${ownedVolume},target=/fixture`,
        '--entrypoint',
        'node',
        imageId,
        '--input-type=module',
        '-e',
        "import fs from 'node:fs/promises'; async function own(p){const s=await fs.lstat(p);if(s.isSymbolicLink())return;await fs.chown(p,10001,10001);if(s.isDirectory())for(const n of await fs.readdir(p))await own(p+'/'+n)} await own('/fixture/source');",
      ]);
      const env = {
        RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
        RIVET_API_PROFILE: 'combined',
        RIVET_SERVER_UI_AUTH_MODE: 'key',
        RIVET_KEY: 'synthetic-restored-host-key-not-a-deployment-secret',
        RIVET_BACKEND_API_PORT: '80',
        RIVET_BACKEND_EXECUTOR_PORT: '21889',
        RIVET_BACKEND_HEALTH_PORT: '21890',
        RIVET_WORKSPACE_ROOT: '/workspace',
        RIVET_WORKFLOWS_ROOT: '/fixture/source/workflows',
        RIVET_WORKFLOW_RECORDINGS_ROOT: '/fixture/source/recordings',
        RIVET_APP_DATA_ROOT: '/fixture/source/appData',
        RIVET_RUNTIME_LIBRARIES_ROOT: '/fixture/source/runtimeLibraries',
        RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED: 'false',
        RIVET_SHUTDOWN_GRACE_SECONDS: '1',
      };
      await backend.start([
        '--network',
        'none',
        '--read-only',
        '--user',
        '10001:10001',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,mode=1777,size=128m',
        '--tmpfs',
        '/workspace:rw,nosuid,nodev,mode=1777,size=16m',
        '--mount',
        `type=volume,source=${ownedVolume},target=/fixture`,
        '--mount',
        `type=volume,source=${ownedVolume},target=/home/rivet/.local/share/com.valerypopoff.rivet2,volume-subpath=source/appData`,
        ...(await restoredLegacyApiMount(entrypointDirectory)),
        ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
        '--entrypoint',
        'node',
        imageId,
        '/opt/rivet/backend-supervisor.mjs',
      ]);
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          await docker(['exec', backendOwner, 'node', '-e', restoredReadinessProbeScript()]);
          ready = true;
          break;
        } catch {
          const state = JSON.parse((await docker(['inspect', backendOwner])).stdout)[0].State;
          assert.equal(state.Running, true, 'Legacy fixture backend exited before readiness.');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      assert.equal(ready, true, 'Legacy fixture backend never became ready.');
    } finally {
      assert.equal((await backend.cleanup(true)).failed, false, 'Owned fixture backend cleanup failed.');
      assert.equal((await tracker.cleanup(true)).failed, false, 'Owned fixture cleanup failed.');
      if (created) {
        const info = JSON.parse((await docker(['volume', 'inspect', ownedVolume])).stdout)[0];
        assert.equal(info.Labels?.['rivet.local-upgrade.restored'], owner);
        await docker(['volume', 'rm', ownedVolume]);
      }
      await fs.rm(entrypointDirectory, { recursive: true, force: true });
    }
  },
);
