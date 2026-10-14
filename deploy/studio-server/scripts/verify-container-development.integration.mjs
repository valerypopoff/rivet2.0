import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { containerServerConfig, createManagedCompose } from './lib/container-server-config.mjs';
import { containerDevelopmentBuildArgs, ensureContainerDevelopmentMountPoints } from './container-server.mjs';
import { cleanupVerification } from '../../../packages/studio-server-web/dev/verification-cleanup.mjs';

// No .env, application containers or data volumes. All edits target a disposable
// source fixture; use the SAME mount model and web target as the real launcher.
const root = process.cwd();
const id = `rivet-watch-${randomUUID()}`;
const output = path.join(root, 'artifacts', id);
const fixture = path.join(output, 'source');
const image = process.argv[2] || 'rivet-development-verification:local';
const browserOnly = process.argv[3] === '--browser-only';
if (process.argv.length > 4 || (process.argv[3] && !browserOnly))
  throw new Error('Use an optional prebuilt development image followed by --browser-only.');
const exec = promisify(execFile);
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 8 * 1024 ** 2 })).stdout.trim();
let interrupted = false;
let active;
const interrupt = () => {
  interrupted = true;
  active?.kill('SIGTERM');
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const run = (program, args, env = process.env) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: 'inherit', shell: false, windowsHide: true });
    active = child;
    child.on('error', reject);
    child.on('exit', (code) => {
      if (active === child) active = undefined;
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}`));
    });
  });
const config = containerServerConfig(
  {
    RIVET_KEY: 'test-only-development-key-'.repeat(3),
    RIVET_LOCAL_POSTGRES_PASSWORD: 'test-postgres',
    RIVET_LOCAL_S3_ACCESS_KEY_ID: 'test-minio',
    RIVET_LOCAL_S3_SECRET_ACCESS_KEY: 'test-minio-password',
  },
  'dev',
  'local-storage',
  root,
);
const web = createManagedCompose(config, { web: image }, { sourceRoot: fixture }).services.web;
let started = false;
let base;
let current;
let failure;
const measurements = [];
async function status() {
  return (await fetch(`${base}/__rivet_dev/status`, { signal: AbortSignal.timeout(5000) })).json();
}
async function waitFor(predicate) {
  const end = Date.now() + 15 * 60_000;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Development verification interrupted');
    const state = await status().catch(() => null);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Watched compilation did not settle: ${JSON.stringify(await status())}`);
}
try {
  await mkdir(fixture, { recursive: true });
  for (const mount of web.volumes.filter((entry) => entry.type === 'bind')) {
    const relative = mount.target.slice('/app/'.length);
    await mkdir(path.dirname(mount.source), { recursive: true });
    await cp(path.join(root, relative), mount.source, {
      recursive: true,
      filter: (file) =>
        !['node_modules', 'dist', 'debug.log'].includes(path.basename(file)) && !path.basename(file).startsWith('.env'),
    });
  }
  if (!process.argv[2]) await run('docker', containerDevelopmentBuildArgs('web', image));
  // A concurrent verification build may move the tag; select one image now.
  const imageId = await docker('image', 'inspect', '--format', '{{.Id}}', image);
  ensureContainerDevelopmentMountPoints(fixture);
  await writeFile(path.join(fixture, 'packages/studio-server-web/node_modules/host-only-marker'), 'must remain hidden');
  await docker(
    'run',
    '--detach',
    '--rm',
    '--init',
    '--name',
    id,
    '--label',
    'rivet.test=container-development',
    '--read-only',
    '--publish',
    '127.0.0.1::5174',
    ...web.volumes
      .filter((entry) => entry.type === 'bind')
      .flatMap((mount) => ['--mount', `type=bind,source=${mount.source},target=${mount.target},readonly`]),
    '--volume',
    '/home/rivet/.cache',
    ...web.tmpfs.flatMap((mount) => ['--tmpfs', mount]),
    imageId,
  );
  started = true;
  assert.equal(
    await docker('exec', id, 'node', '-e', 'console.log(require("fs").existsSync("node_modules/host-only-marker"))'),
    'false',
    'Host dependencies leaked into the development container',
  );
  await writeFile(path.join(output, 'image-id.txt'), imageId);
  const port = (await docker('port', id, '5174/tcp')).split(':').at(-1);
  base = `http://127.0.0.1:${port}`;
  const start = Date.now();
  current = await waitFor((state) => state.phase === 'ready' || state.phase === 'failed');
  assert.equal(current.phase, 'ready', current.error);
  for (const file of ['/.env', '/package.json', '/node_modules/host-only-marker'])
    assert.equal((await fetch(base + file)).status, 404, 'Development server must not expose raw source/configuration');
  measurements.push({ case: 'initial', durationMs: Date.now() - start });
  const initial = current.generation;
  if (!browserOnly) {
    for (const [name, file, addition] of [
      ['css', 'packages/studio-server-web/modal-sizing.css', '\n.rivet-watch-test { color: #123456; }\n'],
      ['tsx', 'packages/studio-server-web/dashboard/DashboardPage.tsx', '\nconsole.info("rivet-watch-tsx");\n'],
      ['core', 'packages/core/src/model/nodes/DelayNode.ts', '\nconsole.info("rivet-watch-core");\n'],
    ]) {
      const start = Date.now();
      const previous = current.generation;
      const target = path.join(fixture, file);
      await writeFile(target + '.save', (await readFile(target, 'utf8')) + addition);
      await rename(target + '.save', target);
      current = await waitFor(
        (state) => (state.generation !== previous && state.phase === 'ready') || state.phase === 'failed',
      );
      assert.equal(current.phase, 'ready', current.error);
      const marker = name === 'css' ? 'rivet-watch-test' : `rivet-watch-${name}`;
      const found = await docker(
        'exec',
        id,
        'node',
        '--input-type=module',
        '-e',
        `import fs from 'node:fs'; const dir=${JSON.stringify(`/home/rivet/.cache/bundles/generations/`)}+${JSON.stringify(current.generation)}+'/assets'; console.log(fs.readdirSync(dir).filter(p=>p.endsWith(${JSON.stringify(name === 'css' ? '.css' : '.js')})).some(p=>fs.readFileSync(dir+'/'+p,'utf8').includes(${JSON.stringify(marker)})));`,
      );
      assert.equal(found, 'true', `${name} source edit did not reach the published bundle`);
      measurements.push({ case: name, durationMs: Date.now() - start });
    }
    const target = path.join(fixture, 'packages/studio-server-web/dashboard/DashboardPage.tsx');
    const original = await readFile(target, 'utf8');
    const lastGood = current.generation;
    await writeFile(target, original + '\nexport const = ;\n');
    await waitFor((state) => state.phase === 'failed');
    assert.equal((await status()).generation, lastGood);
    assert.equal((await fetch(`${base}/?devBuild=${initial}`)).status, 200);
    await writeFile(target, original);
    current = await waitFor((state) => state.phase === 'ready' && state.generation !== lastGood);
  }
  await writeFile(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
  await run(
    process.execPath,
    [path.join(root, '.yarn/releases/yarn-4.17.1.cjs'), 'studio-server:ui:observe', 'tunnel-development.spec.ts'],
    {
      ...process.env,
      PLAYWRIGHT_HEADLESS: '1',
      PLAYWRIGHT_SLOW_MO: '0',
      PLAYWRIGHT_BASE_URL: base,
    },
  );
  console.log(
    `${browserOnly ? 'Browser safety verified (source-edit scenarios not run)' : 'Container source watch and browser refresh verified'}. Evidence: ${output}`,
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  await cleanupVerification(
    [
      async () => {
        if (!started) return;
        const logs = await exec('docker', ['logs', id], { maxBuffer: 8 * 1024 ** 2 });
        await writeFile(path.join(output, 'web.log'), logs.stdout + logs.stderr);
      },
      async () => {
        if (!started) return;
        const inspected = JSON.parse(await docker('inspect', id))[0];
        assert.equal(inspected.Config.Labels['rivet.test'], 'container-development');
        await docker('stop', '--time', '10', id);
      },
      () => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      },
    ],
    failure,
  );
}
