import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pullReleaseManifestArtifact } from './release-manifest-oci.mjs';
import { getStudioServerReleaseManifestDigest } from './lib/studio-server-release-manifest.mjs';
import { proxyReusePlan } from './lib/component-image-reuse.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export async function prepareProxyImage({
  rootDir = root,
  env = process.env,
  pull = pullReleaseManifestArtifact,
  execute = (bin, args) =>
    execFileSync(bin, args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
} = {}) {
  const directory = path.join(rootDir, 'artifacts/component-image-origin');
  await fs.mkdir(directory, { recursive: true });
  let plan = null;
  if (env.GITHUB_REF === 'refs/heads/main' && env.ALLOW_RELEASE_LINEAGE_BOOTSTRAP !== 'true') {
    const pinned = env.INSTALLED_PREDECESSOR_DIGEST;
    if (pinned) assert.match(pinned, /^sha256:[a-f0-9]{64}$/);
    const reference = `ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest:${pinned ? 'manifest-' + pinned.slice(7) : 'production'}`;
    const pulled = await pull(reference, path.join(directory, 'baseline.json'), { allowMissing: !pinned });
    const baseline = pulled?.manifest;
    if (pinned) assert.ok(baseline, 'Pinned installed predecessor is missing');
    if (baseline) {
      if (pinned) assert.equal(getStudioServerReleaseManifestDigest(baseline, { requirePromoted: true }), pinned);
      assert.equal(baseline.source.repository, env.GITHUB_REPOSITORY);
      assert.match(baseline.source.sha, /^[a-f0-9]{40}$/);
      // Full history is fetched by checkout. Missing source never enables reuse.
      plan = proxyReusePlan({
        root: rootDir,
        sourceSha: env.GITHUB_SHA,
        repository: env.GITHUB_REPOSITORY,
        predecessor: baseline,
      });
      if (plan) {
        const source = `${plan.image.repository}@${plan.image.digest}`;
        const tag = `${plan.image.repository}:${env.SOURCE_TAG}`;
        assert.match(
          tag,
          /^ghcr\.io\/valerypopoff\/rivet2\.0-studio-server\/proxy:candidate-[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*$/,
        );
        // A single-source carbon copy preserves the immutable index. No write retry
        // on unknown acknowledgement; readback failure ends this build attempt.
        await execute('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', tag, source]);
        assert.equal(
          (
            await execute('docker', ['buildx', 'imagetools', 'inspect', tag, '--format', '{{.Manifest.Digest}}'])
          ).trim(),
          plan.image.digest,
        );
      }
    }
  }
  await fs.writeFile(path.join(directory, 'proxy.json'), JSON.stringify(plan ?? null));
  await fs.appendFile(env.GITHUB_OUTPUT, `reused=${!!plan}\n`);
  return plan;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareProxyImage();
