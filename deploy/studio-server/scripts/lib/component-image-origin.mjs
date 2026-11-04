import assert from 'node:assert/strict';

export function assertImageOrigins(origins, manifest) {
  assert.ok(origins && typeof origins === 'object' && !Array.isArray(origins));
  assert.deepEqual(Object.keys(origins), ['proxy'], 'Only the closed proxy recipe supports image reuse');
  const origin = origins.proxy,
    baseline = manifest.lineage?.predecessor;
  assert.ok(baseline, 'Reused images require an exact installed predecessor');
  assert.match(origin.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(origin.inputsDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(origin.predecessorDigest, baseline.manifestDigest);
  assert.deepEqual(manifest.images.proxy, baseline.images.proxy, 'Reused image differs from its predecessor');
  return {
    proxy: {
      sourceSha: origin.sourceSha,
      inputsDigest: origin.inputsDigest,
      predecessorDigest: origin.predecessorDigest,
    },
  };
}
