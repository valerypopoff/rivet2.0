import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HELM_VERSION, installCachedHelm, resolveHelmBin } from './lib/k8s-tools.mjs';

const rootDir = process.cwd();

export async function configurePinnedHelmForCi(
  root,
  { env = process.env, install = installCachedHelm, run = spawnSync } = {},
) {
  assert.ok(env.GITHUB_ENV && path.isAbsolute(env.GITHUB_ENV), 'GitHub environment file is required');
  // A hosted runner's PATH (or an inherited override) can contain a different
  // Helm major. Select the checksum-verified repository pin explicitly.
  const bin = await install(root);
  assert.ok(typeof bin === 'string' && !/[\r\n]/.test(bin));
  const result = run(bin, ['version', '--template', '{{.Version}}'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 65536,
  });
  assert.ok(
    !result.error && result.status === 0 && result.stdout?.trim() === HELM_VERSION,
    `Pinned Helm ${HELM_VERSION} version check failed`,
  );
  await fs.appendFile(env.GITHUB_ENV, `RIVET_K8S_HELM_BIN=${bin}\n`);
  return bin;
}

async function main() {
  if (process.argv.includes('--github-env')) {
    const bin = await configurePinnedHelmForCi(rootDir);
    console.log(`[setup:k8s-tools] Selected pinned Helm ${HELM_VERSION} at ${bin}`);
    return;
  }
  const existing = resolveHelmBin(rootDir);
  if (existing) {
    console.log(`[setup:k8s-tools] Helm ready from ${existing.source} at ${existing.bin}`);
    return;
  }

  const cachedHelm = await installCachedHelm(rootDir);
  console.log(`[setup:k8s-tools] Cached Helm ready at ${path.relative(rootDir, cachedHelm)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
