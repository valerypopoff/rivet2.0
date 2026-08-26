import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  buildManagedReleaseGateConfig,
  imageReference,
  renderManagedReleaseGateValues,
} from '../../../../scripts/lib/kubernetes-managed-release-gate-config.mjs';

const rootDir = path.resolve(import.meta.dirname, '../../../..');
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

function createEnvironment(overrides = {}) {
  return {
    RIVET_K8S_RELEASE_GATE_CONTEXT: 'kind-rivet-managed-release',
    RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: 'kind-rivet-managed-release',
    RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_RELEASE_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_RELEASE_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_RELEASE_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_RELEASE_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: 'release-gate',
    RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD: 'release-gate-token',
    ...overrides,
  };
}

test('managed release gate fixture declares the runtime environment assertion', async () => {
  const fixturePath = path.join(rootDir, 'scripts', 'fixtures', 'managed-release-gate.rivet-project');
  const fixture = await fs.readFile(fixturePath, 'utf8');

  assert.match(fixture, /\[environment-node\]:code "Environment"/);
  assert.match(fixture, /process\.env\.RIVET_RELEASE_GATE_VALUE/);
  assert.match(fixture, /output->"Delay" delay-node\/input1/);
});

test('managed release gate requires an exact explicitly allowed kube context', () => {
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: 'production' }) }),
    /must match exactly/,
  );
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: '' }) }),
    /ALLOW_CONTEXT is required/,
  );
});

test('managed release gate requires every immutable candidate image digest', () => {
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_API_IMAGE_DIGEST: 'latest' }) }),
    /must be a sha256 OCI digest/,
  );
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_REPOSITORY: '' }) }),
    /EXECUTOR_IMAGE_REPOSITORY is required/,
  );
});

test('managed release gate renders managed storage and digest-pinned image values', () => {
  const config = buildManagedReleaseGateConfig({ rootDir, env: createEnvironment(), mode: 'release' });
  const values = renderManagedReleaseGateValues(config);

  assert.equal(config.mode, 'release');
  assert.equal(values.images.proxy.pullPolicy, 'Always');
  assert.equal(values.images.proxy.digest, digest('a'));
  assert.equal(values.postgres.host, 'release-gate-postgres');
  assert.equal(values.objectStorage.endpoint, 'http://release-gate-minio:9000');
  assert.equal(values.objectStorage.bucket, 'rivet-release-gate');
  assert.equal(imageReference(config.images.executor), `example.test/rivet/executor@${digest('d')}`);
});

test('managed release gate rejects unsafe artifact paths and requires registry credentials', () => {
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_ARTIFACTS_DIR: '../outside' }) }),
    /must remain inside the repository/,
  );
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: '' }) }),
    /REGISTRY_USERNAME is required/,
  );
  assert.throws(
    () => buildManagedReleaseGateConfig({ rootDir, env: createEnvironment({ RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: 'ci-user', RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD: '' }) }),
    /REGISTRY_PASSWORD is required/,
  );
});