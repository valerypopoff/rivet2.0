import test from 'node:test';
import assert from 'node:assert/strict';
import { HaReleaseGate, validateHaCertificationManifest } from './kubernetes-ha-release-gate.mjs';
import { parseAllDocuments } from 'yaml';
import { fileURLToPath } from 'node:url';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
function certificationFixture(predecessorRelease = null) {
  const images = Object.fromEntries(
    ['proxy', 'web', 'api', 'executor'].map((key, index) => [
      key,
      { repository: `example.test/rivet/${key}`, digest: `sha256:${String(index + 1).repeat(64)}` },
    ]),
  );
  const sourceSha = 'a'.repeat(40);
  const manifest = createStudioServerReleaseManifest({
    rootDir,
    source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: sourceSha },
    images,
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    predecessorRelease,
  });
  return { manifest, options: { rootDir, sourceSha, images, previous: predecessorRelease } };
}

test('HA certification accepts exact candidates without treating them as deployable releases', () => {
  const { manifest, options } = certificationFixture();
  assert.equal(validateHaCertificationManifest(manifest, options).mode, 'bootstrap');
  const reordered = Object.fromEntries(Object.entries(options.images).reverse());
  assert.equal(validateHaCertificationManifest(manifest, { ...options, images: reordered }).mode, 'bootstrap');
  const promoted = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  assert.throws(() => validateHaCertificationManifest(promoted, options), /requires a candidate/);
});

test('HA candidate preflight preserves source, chart, image and exact predecessor checks', () => {
  const { manifest, options } = certificationFixture();
  assert.throws(
    () => validateHaCertificationManifest(manifest, { ...options, sourceSha: 'b'.repeat(40) }),
    /current checkout/,
  );
  assert.throws(
    () => validateHaCertificationManifest({
      ...manifest, chart: { ...manifest.chart, contentDigest: `sha256:${'f'.repeat(64)}` },
    }, options),
    /current Helm chart/,
  );
  assert.throws(
    () => validateHaCertificationManifest(manifest, {
      ...options,
      images: { ...options.images, api: { ...options.images.api, digest: `sha256:${'f'.repeat(64)}` } },
    }),
    /HA images must match/,
  );
  const previous = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  const next = certificationFixture(previous);
  assert.equal(validateHaCertificationManifest(next.manifest, next.options).mode, 'bootstrap');
  assert.throws(() => validateHaCertificationManifest(next.manifest, { ...next.options, previous: null }), /predecessor/);
});

test('disposable PostgreSQL really provides the HA fixture connection budget', async () => {
  const gate = new HaReleaseGate({ namespace: 'fixture' }, 'unused', 'unused');
  let postgres;
  gate.kubectl = async (args, extra) => {
    if (args[0] === 'get') return { stdout: 'local-node' };
    if (extra?.input)
      for (const doc of parseAllDocuments(extra.input)) {
        assert.equal(doc.errors.length, 0);
        const resource = doc.toJSON();
        if (resource?.kind === 'Deployment' && resource.metadata.name === 'release-gate-postgres')
          postgres = resource.spec.template.spec.containers[0];
      }
    return { stdout: '' };
  };
  gate.waitForDependency = async () => {};
  await gate.installDependencies();
  assert.deepEqual(postgres.args, ['postgres', '-c', 'max_connections=250']);
});

test('HA preparation never deletes or rotates Secrets in an existing namespace', async () => {
  const gate = new HaReleaseGate({ namespace: 'existing' }, 'unused', 'unused');
  const calls = [];
  gate.assertLocalContext = async () => {};
  gate.kubectl = async (args) => {
    calls.push(args);
    return { stdout: 'namespace/existing\n' };
  };
  gate.createNamespace = async () => {
    throw Error('must not mutate');
  };
  await assert.rejects(gate.prepare(), /fresh disposable namespace/);
  assert.deepEqual(calls, [['get', 'namespace', 'existing', '--ignore-not-found', '-o', 'name']]);
});

test('the local proof cannot select a production context, even when allow-context matches', async () => {
  const gate = new HaReleaseGate({ context: 'gke-production', allowedContext: 'gke-production' }, 'unused', 'unused');
  gate.kubectl = async () => {
    throw Error('must not access cluster');
  };
  await assert.rejects(gate.assertLocalContext(), /disposable local cluster/);
});
