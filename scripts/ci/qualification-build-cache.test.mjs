import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationBuildArgs } from './qualification-build-cache.mjs';
import { spawnSync } from 'node:child_process';
// test-style: fixture-read: reads only the temporary environment file produced by the action.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  RIVET_QUALIFICATION_BUILDER: 'rivet-qualification',
  ACTIONS_RUNTIME_TOKEN: 'private-fixture-token',
  ACTIONS_RESULTS_URL: 'https://cache.example.invalid/',
};
const args = ['--platform=linux/amd64', '--tag', 'fixture:actor', '/clean/source'];
test('cache runtime action exposes credentials only through its environment file and rejects multiline input atomically', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-cache-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'env');
  const program = fileURLToPath(new URL('../../.github/actions/build-cache-runtime/runtime.cjs', import.meta.url));
  const run = (change) =>
    spawnSync(process.execPath, [program], {
      encoding: 'utf8',
      env: {
        GITHUB_ENV: file,
        ACTIONS_RUNTIME_TOKEN: 'fixture-only-token',
        ACTIONS_RESULTS_URL: 'https://cache.invalid',
        ...change,
      },
    });
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '::add-mask::fixture-only-token\n');
  assert.equal(result.stderr, '');
  assert.equal(
    await fs.readFile(file, 'utf8'),
    'ACTIONS_RUNTIME_TOKEN=fixture-only-token\nACTIONS_RESULTS_URL=https://cache.invalid\n',
  );
  await fs.writeFile(file, 'untouched');
  const invalid = run({ ACTIONS_RESULTS_URL: 'invalid\nANOTHER_VARIABLE=injected' });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.equal(await fs.readFile(file, 'utf8'), 'untouched');
  assert.ok(!invalid.stderr.includes('fixture-only-token'));
});
test('local builds retain their existing command; hosted builds preserve local archive output', () => {
  assert.deepEqual(qualificationBuildArgs('actor', args, {}), ['build', ...args]);
  const cached = qualificationBuildArgs('actor', args, env);
  assert.deepEqual(cached.slice(-args.length), args);
  assert.ok(cached.includes('--load'));
  assert.ok(cached.includes('--builder'));
  assert.ok(cached.includes('type=gha,version=2,scope=rivet-qualification-actor-linux-amd64,timeout=60s'));
  assert.ok(cached.some((x) => x.includes('mode=max,ignore-error=true,timeout=60s')));
  assert.ok(!cached.join(' ').includes(env.ACTIONS_RUNTIME_TOKEN));
  assert.notDeepEqual(cached, qualificationBuildArgs('janitor', args, env));
});
test('untrusted/invalid cache inputs fail before a build; an explicit cold path needs no cache credential', () => {
  for (const change of [
    { GITHUB_REF: 'refs/pull/1/merge' },
    { GITHUB_ACTIONS: 'false' },
    { RIVET_QUALIFICATION_BUILDER: 'bad,token=exposed' },
    { ACTIONS_RUNTIME_TOKEN: '' },
    { ACTIONS_RESULTS_URL: '' },
    { RIVET_QUALIFICATION_CACHE: 'unknown' },
  ])
    assert.throws(() => qualificationBuildArgs('actor', args, { ...env, ...change }));
  const cold = qualificationBuildArgs('actor', args, {
    ...env,
    ACTIONS_RUNTIME_TOKEN: '',
    RIVET_QUALIFICATION_CACHE: 'off',
  });
  assert.ok(cold.includes('--load'));
  assert.ok(!cold.includes('--cache-from'));
  assert.throws(() => qualificationBuildArgs('unknown', args, env));
});
