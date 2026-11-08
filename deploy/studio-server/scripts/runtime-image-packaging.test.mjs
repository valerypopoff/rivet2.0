import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readRuntimeDependencyArchive,
  assertRuntimeDependencyReuse,
  assertColdRuntimeDependencyBuild,
} from './verify-runtime-image-packaging.mjs';

test('complete OCI layer identity survives wrappers/attestations and dependency changes invalidate reuse', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-layer-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'blobs/sha256'), { recursive: true });
  const blob = async (value) => {
    const text = JSON.stringify(value);
    const digest = 'sha256:' + createHash('sha256').update(text).digest('hex');
    await fs.writeFile(path.join(root, 'blobs/sha256', digest.slice(7)), text);
    return { digest };
  };
  const config = await blob({ rootfs: { diff_ids: ['sha256:' + 'a'.repeat(64)] } });
  const layer = {
    digest: 'sha256:' + 'b'.repeat(64),
    size: 1234,
    mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
  };
  const manifest = await blob({ config, layers: [layer] });
  const index = await blob({
    manifests: [
      { digest: 'sha256:' + 'c'.repeat(64), platform: { os: 'unknown', architecture: 'unknown' } },
      { ...manifest, platform: { os: 'linux', architecture: 'amd64' } },
    ],
  });
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({ manifests: [index] }));
  const archive = path.join(root, 'fixture.tar');
  execFileSync('tar', ['-cf', archive, '-C', root, 'index.json', 'blobs'], { windowsHide: true });
  const baseline = readRuntimeDependencyArchive(archive);
  assert.equal(baseline.diffId, 'sha256:' + 'a'.repeat(64));
  assert.equal(baseline.bytes, 1234);
  const values = {
    baseline,
    sourceChanged: { ...baseline },
    cold: { ...baseline },
    dependencyChanged: { ...baseline, diffId: 'sha256:' + 'd'.repeat(64) },
  };
  assert.doesNotThrow(() => assertRuntimeDependencyReuse(values));
  assert.throws(
    () => assertRuntimeDependencyReuse({ ...values, cold: { ...baseline, digest: 'sha256:' + 'e'.repeat(64) } }),
    /not reusable/,
  );
  assert.throws(
    () => assertRuntimeDependencyReuse({ ...values, dependencyChanged: { ...baseline } }),
    /must invalidate/,
  );
  const log =
    '#12 [dependencies 5/5] RUN yarn install\n#12 DONE 20s\n#20 [esbuild-security 3/3] RUN sh /rebuild-esbuild.sh\n#20 DONE 10s';
  assert.doesNotThrow(() => assertColdRuntimeDependencyBuild(log));
  assert.throws(() => assertColdRuntimeDependencyBuild(log.replace('#12 DONE 20s', '#12 CACHED')), /reused/);
  assert.throws(() => assertColdRuntimeDependencyBuild(''), /actual dependency/);
});
