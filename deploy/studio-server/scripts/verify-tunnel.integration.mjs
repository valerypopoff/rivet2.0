import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { cleanupVerification } from '../../../packages/studio-server-web/dev/verification-cleanup.mjs';

// No normal Compose up/down, production images, .env copying or data mounts.
// Only disposable UUID-labelled code/cache volumes are writable.
const exec = promisify(execFile);
const root = process.cwd();
const id = `rivet-tunnel-${randomUUID()}`;
const label = 'rivet.test=tunnel-integration';
const output = path.join(root, 'artifacts', id);
const volumes = [`${id}-code`, `${id}-cache`];
// Copy only frontend build inputs. In particular, desktop Rust target/promo/
// sidecar trees are neither needed nor appropriate for a tunnel verification.
const inputs = [
  'package.json',
  'yarn.lock',
  'tsconfig.base.json',
  'packages/studio-server-web',
  'packages/studio-server-shared',
  'packages/app/src',
  'packages/app/graphs',
  'packages/app/public',
  'packages/app/scripts',
  'packages/app/package.json',
  'packages/app/tsconfig.json',
  ...['core', 'evaluations', 'node'].flatMap((name) => [
    `packages/${name}/src`,
    `packages/${name}/dist`,
    `packages/${name}/package.json`,
    `packages/${name}/tsconfig.json`,
  ]),
  'packages/studio-server-api/src',
];
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
let interrupted = false;
let active;
const interrupt = () => {
  interrupted = true;
  active?.kill('SIGTERM');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const run = (command, args, env = process.env) =>
  new Promise((resolve, reject) => {
    if (interrupted) {
      reject(new Error('Isolated verification interrupted'));
      return;
    }
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    active = child;
    child.on('error', reject);
    child.on('exit', (code) => {
      if (active === child) active = undefined;
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited ${code}`));
    });
  });
let started = false;
let browserMode;
let failure;
async function retainBrowserArtifacts(mode) {
  for (const directory of ['report', 'test-results']) {
    await cp(path.join(root, 'artifacts', 'playwright', directory), path.join(output, `${mode}-${directory}`), {
      recursive: true,
    });
  }
  await cp(
    path.join(root, 'artifacts', 'tunnel-browser-measurements', `${mode}.json`),
    path.join(output, `${mode}-browser-measurement.json`),
  ).catch(() => undefined);
}
const created = [];
await mkdir(output, { recursive: true });
try {
  const source = JSON.parse(await docker('inspect', 'rivet-studio-server-dev-web-1'))[0];
  assert.equal(source.Config.Labels['com.docker.compose.project'], 'rivet-studio-server-dev');
  const dependencies = source.Mounts.find((mount) => mount.Destination === '/workspace/node_modules');
  assert.equal(dependencies?.Type, 'volume', 'Start the normal dev stack once to provision dependencies');
  // Compare real Compose service configurations without reading the user's .env.
  const envFile = path.join(output, 'fixture.env');
  await writeFile(envFile, 'RIVET_DEV_STACK_INPUT_FINGERPRINT=tunnel-test\n');
  const config = async (mode) =>
    JSON.parse(
      (
        await exec(
          'docker',
          [
            'compose',
            '--env-file',
            envFile,
            '-f',
            'deploy/studio-server/compose/docker-compose.managed-services.yml',
            '-f',
            'deploy/studio-server/compose/docker-compose.dev.yml',
            'config',
            '--format',
            'json',
          ],
          {
            env: {
              ...process.env,
              RIVET_DEV_FRONTEND_MODE: mode,
              RIVET_DEV_WEB_START_PERIOD: mode === 'tunnel' ? '900s' : '180s',
            },
            maxBuffer: 4 * 1024 * 1024,
          },
        )
      ).stdout,
    );
  const live = await config('live');
  const tunnel = await config('tunnel');
  for (const [name, service] of Object.entries(live.services)) {
    if (name !== 'web') assert.deepEqual(tunnel.services[name], service, `Frontend mode changed ${name}`);
  }
  assert.deepEqual(live.services.web.volumes, tunnel.services.web.volumes);
  for (const volume of volumes) {
    await docker('volume', 'create', '--label', label, volume);
    created.push(volume);
  }
  const launchStart = Date.now();
  await docker(
    'run',
    '--detach',
    '--rm',
    '--init',
    '--name',
    id,
    '--label',
    label,
    '--read-only',
    '--mount',
    `type=bind,source=${root},target=/source,readonly`,
    '--mount',
    `type=volume,source=${volumes[0]},target=/workspace`,
    '--mount',
    `type=volume,source=${dependencies.Name},target=/workspace/node_modules,readonly`,
    '--mount',
    `type=volume,source=${volumes[1]},target=/tunnel-cache`,
    '--mount',
    `type=bind,source=${output},target=/workspace/artifacts`,
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/workspace/node_modules/.monaco',
    '--tmpfs',
    '/workspace/packages/studio-server-web/node_modules/.vite-temp',
    '--env',
    'RIVET_DEV_FRONTEND_MODE=tunnel',
    '--env',
    'RIVET_DEV_BUNDLE_ROOT=/tunnel-cache',
    '--env',
    'HOSTED_VITE_CACHE_DIR=/tunnel-cache/vite',
    '--env',
    'NODE_OPTIONS=',
    '--publish',
    '127.0.0.1::5174',
    '--publish',
    '127.0.0.1::5175',
    '--workdir',
    '/workspace',
    '--entrypoint',
    'sh',
    'node:20-alpine',
    '-c',
    `set -eu; tar -C /source --exclude='*/node_modules' --exclude='*/.env*' --exclude='*/artifacts' --exclude='*/.git' --exclude='packages/studio-server-web/dist' -cf - ${inputs.join(' ')} | tar -C /workspace -xf -; node /workspace/node_modules/typescript/bin/tsc -p packages/studio-server-web/tsconfig.google-hosted-override.json; exec node packages/studio-server-web/dev/tunnel.mjs`,
  );
  started = true;
  const port = (await docker('port', id, '5174/tcp')).split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  console.log(`[tunnel-integration] Isolated code fixture ${base}; reports: ${output}`);
  // docker run returns before the private source copy has completed. Do not
  // execute a copied helper until the HTTP supervisor is actually listening.
  const copyDeadline = Date.now() + 120_000;
  let listening = false;
  while (Date.now() < copyDeadline) {
    assert.equal(interrupted, false, 'Isolated verification interrupted');
    try {
      listening = (await fetch(`${base}/__rivet_dev/status`, { signal: AbortSignal.timeout(5_000) })).ok;
    } catch {
      /* still copying */
    }
    if (listening) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(listening, 'Isolated fixture did not finish copying/start HTTP within two minutes');
  await run('docker', [
    'exec',
    '--env',
    'RIVET_TUNNEL_OWNED_FIXTURE=1',
    '--env',
    `RIVET_FIXTURE_LAUNCH_AT=${launchStart}`,
    id,
    'node',
    'packages/studio-server-web/dev/exercise-tunnel.mjs',
  ]);
  await writeFile(
    path.join(output, 'launch.json'),
    JSON.stringify(
      { launchThroughSourceChecksMs: Date.now() - launchStart, nonWebComposeServicesUnchanged: true },
      null,
      2,
    ),
  );
  const browserEnv = { ...process.env, PLAYWRIGHT_BASE_URL: base, PLAYWRIGHT_HEADLESS: '1', PLAYWRIGHT_SLOW_MO: '0' };
  const yarn = path.join(root, '.yarn', 'releases', 'yarn-4.17.1.cjs');
  browserMode = 'tunnel';
  await run(
    process.execPath,
    [yarn, 'studio-server:ui:observe', 'tunnel-development.spec.ts', 'tunnel-request-count.spec.ts'],
    browserEnv,
  );
  await retainBrowserArtifacts(browserMode);
  browserMode = undefined;
  // Same code/dependencies, ordinary Vite mode. No API/executor stack mutation.
  await docker(
    'exec',
    '--detach',
    '--env',
    'RIVET_DEV_FRONTEND_MODE=live',
    '--env',
    'HOSTED_VITE_CACHE_DIR=/tunnel-cache/live',
    id,
    'sh',
    '-c',
    'cd /workspace/packages/studio-server-web; exec node /workspace/node_modules/vite/bin/vite.js --host 0.0.0.0 --strictPort --port 5175 >/workspace/artifacts/live.log 2>&1',
  );
  const livePort = (await docker('port', id, '5175/tcp')).split(':').at(-1);
  browserMode = 'live';
  await run(
    process.execPath,
    [
      yarn,
      'studio-server:ui:observe',
      'tunnel-request-count.spec.ts',
      'tunnel-development.spec.ts',
      '--grep',
      'request-count|nested editor import failure|entry module failure',
    ],
    { ...browserEnv, PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${livePort}` },
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  await cleanupVerification(
    [
      async () => {
        if (browserMode) await retainBrowserArtifacts(browserMode);
      },
      async () => {
        if (!started) return;
        const logs = await exec('docker', ['logs', id], { maxBuffer: 8 * 1024 * 1024 }).catch(() => null);
        await writeFile(
          path.join(output, 'container.log'),
          logs ? `${logs.stdout}\n${logs.stderr}` : 'Logs unavailable',
        );
      },
      async () => {
        if (!started) return;
        const inspected = await docker('inspect', id).catch(() => null);
        if (inspected) {
          const owned = JSON.parse(inspected)[0];
          assert.equal(owned.Config.Labels['rivet.test'], 'tunnel-integration');
          await docker('stop', '--timeout', '10', id);
        }
      },
      ...created.map((volume) => async () => {
        const owned = JSON.parse(await docker('volume', 'inspect', volume))[0];
        assert.equal(owned.Labels['rivet.test'], 'tunnel-integration');
        await docker('volume', 'rm', volume);
      }),
      () => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      },
    ],
    failure,
  );
}
console.log(
  '[tunnel-integration] PASS: real source edits, failure/repair, browser safety, both frontend modes, and owned cleanup. Authenticated external tunnel not tested.',
);
