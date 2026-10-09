import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));

// test-style: fixture-read: Read only the fake Docker CLI's test-owned JSONL trace, never production source.
// Execute real launcher entry points against a fake Docker CLI: no daemon,
// image pull, service restart, or ambient dotenv is touched by these checks.
for (const [launcher, action, mode, configuredLimit, failureAt] of [
  ['prod-docker', 'prebuilt', null, null],
  ['prod-docker', 'restart', null, null],
  ['prod-docker', 'custom', null, null],
  ['prod-docker', 'prebuilt', null, '7'],
  ['dev-docker', 'dev', 'live', null],
  ['dev-docker', 'dev', 'tunnel', null],
  ['dev-docker', 'recreate', null, null],
  ['dev-docker', 'build', null, null],
  ['dev-docker', 'up', null, null],
  ['prod-docker', 'prebuilt', null, null, 'pull'],
  ['dev-docker', 'dev', 'tunnel', null, 'up'],
]) {
  const name = [launcher, action, mode, configuredLimit, failureAt && `failure at ${failureAt}`]
    .filter(Boolean)
    .join(' ');
  test(`${name} reports startup phases and preserves its concurrency policy`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'rivet-launcher-startup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const trace = path.join(root, 'docker.jsonl');
    const stub = path.join(bin, 'docker.mjs');
    writeFileSync(
      stub,
      `
      import { appendFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ args,
        limit: process.env.COMPOSE_PARALLEL_LIMIT, mode: process.env.RIVET_DEV_FRONTEND_MODE }) + '\\n');
      if (args.includes('pull')) console.log('fixture-live-pull');
      if (args.includes('up')) console.log('fixture-live-start');
      if (args.includes('build')) console.log('fixture-live-build');
      if (args.includes('--services') && args.includes('proxy')) console.log('proxy');
      if (args.includes(process.env.FIXTURE_FAIL_COMMAND)) {
        console.error('fixture-startup-failure');
        process.exitCode = 17;
      }
    `,
    );
    const windows = process.platform === 'win32';
    writeFileSync(
      path.join(bin, windows ? 'docker.cmd' : 'docker'),
      windows ? `@"${process.execPath}" "${stub}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`,
      { mode: 0o755 },
    );
    const compose = path.join(root, 'deploy/studio-server/compose');
    mkdirSync(compose, { recursive: true });
    for (const name of [
      'docker-compose.managed-services.yml',
      'docker-compose.dev.yml',
      'docker-compose.runtime-env.yml',
    ]) {
      writeFileSync(path.join(compose, name), 'services: {}\n');
    }
    // Phase labels must not be inferred from tokens inside an operator-owned path.
    const dotenv = path.join(root, 'fixture pull down .env');
    writeFileSync(dotenv, 'RIVET_STUDIO_SERVER_COMPOSE_PROJECT=fixture\n');
    const env = { ...process.env, RIVET_ENV_FILE: dotenv, FIXTURE_TRACE: trace };
    // Do not inherit the operator's startup selectors or secrets into a fixture.
    for (const key of Object.keys(env)) {
      if (key.startsWith('RIVET_') && key !== 'RIVET_ENV_FILE') delete env[key];
    }
    delete env.COMPOSE_PARALLEL_LIMIT;
    delete env.FIXTURE_FAIL_COMMAND;
    if (failureAt) env.FIXTURE_FAIL_COMMAND = failureAt;
    if (configuredLimit) env.COMPOSE_PARALLEL_LIMIT = configuredLimit;
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
    const launch = () =>
      exec(process.execPath, [path.join(scripts, `${launcher}.mjs`), action, ...(mode ? [mode] : [])], {
        cwd: root,
        env,
        timeout: 20_000,
      });
    let stdout;
    if (failureAt) {
      await assert.rejects(launch, (error) => {
        stdout = error.stdout;
        assert.equal(error.code, 1, 'the launcher must fail, not hide a failed Docker operation');
        assert.match(error.stderr, /fixture-startup-failure/);
        return true;
      });
    } else {
      ({ stdout } = await launch());
    }
    assert.match(stdout, /Reading startup readiness limits…/);
    assert.match(stdout, /completed \(\d+s\)/);
    assert.match(stdout, /fixture-live-(pull|start|build)/);
    const calls = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const starts = calls.filter(({ args }) => args.includes('pull') || args.includes('up') || args.includes('build'));
    assert.ok(starts.length);
    if (failureAt) {
      const step =
        failureAt === 'pull' ? 'Pulling production images' : 'Starting development services; waiting for readiness';
      assert.ok(stdout.includes(`${step}: failed (`));
      assert.ok(!stdout.includes(`${step}: completed (`));
      if (failureAt === 'pull') assert.ok(!calls.some(({ args }) => args.includes('up')));
      else assert.ok(!calls.some(({ args }) => args.includes('reload')));
    }
    assert.ok(
      starts.every(
        ({ limit }) => limit === (configuredLimit ?? (launcher === 'prod-docker' && action !== 'custom' ? '2' : '1')),
      ),
    );
    if (mode) assert.ok(starts.every((call) => call.mode === mode));
    if (action === 'prebuilt' && !failureAt) {
      assert.ok(stdout.indexOf('Pulling production images…') < stdout.indexOf('fixture-live-pull'));
      assert.match(stdout, /Recreating services; waiting for readiness…/);
      assert.ok(
        calls.findIndex(({ args }) => args.includes('pull')) < calls.findIndex(({ args }) => args.includes('up')),
      );
    }
    if (action === 'up') assert.match(stdout, /attached mode; streaming Docker output/);
    if (launcher === 'prod-docker' && action === 'restart') {
      assert.match(stdout, /Recreating services; waiting for readiness…/);
      assert.doesNotMatch(stdout, /Pulling production images…/);
    }
    if (launcher === 'dev-docker' && action === 'recreate') {
      assert.match(stdout, /Stopping development services…/);
      assert.match(stdout, /Building and starting development services; waiting for readiness…/);
    }
    if (launcher === 'dev-docker' && action === 'dev') {
      assert.match(stdout, /Starting development services; waiting for readiness…/);
      assert.doesNotMatch(stdout, /Stopping development services…/);
    }
    if (mode === 'tunnel') assert.match(stdout, /watched bundles with safe full refresh/);
  });
}
