import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configurePinnedHelmForCi } from './ensure-k8s-tools.mjs';
import { HELM_VERSION } from './lib/k8s-tools.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ci-helm-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'github-env');
  await fs.writeFile(file, 'EXISTING=value\n');
  return { root, file, env: { GITHUB_ENV: file, PATH: 'host-helm-4', RIVET_K8S_HELM_BIN: 'host-helm-4' } };
}

test('CI explicitly selects the repository pin despite host Helm and inherited overrides', async (t) => {
  const { root, file, env } = await fixture(t),
    selected = path.join(root, 'pinned', 'helm');
  const bin = await configurePinnedHelmForCi(root, {
    env,
    install: async (directory) => {
      assert.equal(directory, root);
      return selected;
    },
    run: (program, args) => {
      assert.equal(program, selected);
      assert.deepEqual(args, ['version', '--template', '{{.Version}}']);
      return { status: 0, stdout: HELM_VERSION };
    },
  });
  assert.equal(bin, selected);
  assert.equal(await fs.readFile(file, 'utf8'), `EXISTING=value\nRIVET_K8S_HELM_BIN=${selected}\n`);
});

test('a wrong or failed pinned Helm never reaches the job environment', async (t) => {
  const { root, file, env } = await fixture(t);
  for (const result of [
    { status: 0, stdout: 'v4.0.0' },
    { status: 1, stdout: HELM_VERSION },
    { error: Error('launch failed') },
  ]) {
    await assert.rejects(
      configurePinnedHelmForCi(root, { env, install: async () => path.join(root, 'helm'), run: () => result }),
      /version check failed/,
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'EXISTING=value\n');
  }
});

test('missing CI output or a malformed executable path fails without exporting a tool', async (t) => {
  const { root, file, env } = await fixture(t);
  await assert.rejects(configurePinnedHelmForCi(root, { env: {} }), /environment file is required/);
  await assert.rejects(configurePinnedHelmForCi(root, { env, install: async () => 'helm\nOTHER=value' }));
  assert.equal(await fs.readFile(file, 'utf8'), 'EXISTING=value\n');
});
