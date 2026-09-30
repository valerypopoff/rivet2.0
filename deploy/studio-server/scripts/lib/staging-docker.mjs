import assert from 'node:assert/strict';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const imageNamespace = 'ghcr.io/valerypopoff/rivet2.0-studio-server';
const services = ['proxy', 'web', 'api', 'executor'];
const artifactMounts = new Map([
  ['/workflows', 'RIVET_WORKFLOWS_HOST_PATH'],
  ['/workflow-recordings', 'RIVET_WORKFLOW_RECORDINGS_HOST_PATH'],
  ['/data/runtime-libraries', 'RIVET_RUNTIME_LIBS_HOST_PATH'],
]);
const stateVolumeTargets = [
  '/workspace',
  '/data/rivet-app',
  '/home/rivet/.local/share/com.valerypopoff.rivet2',
  '/data/local-metadata',
];

export function assertStagingCheckout({ branch, revision, status }) {
  assert.equal(branch.trim(), 'staging', 'Staging deployment requires the staging Git branch.');
  assert.match(revision.trim(), /^[a-f0-9]{40}$/, 'Staging checkout has no valid Git commit.');
  assert.equal(status.trim(), '', 'Staging deployment requires a clean tracked checkout.');
  return revision.trim();
}

export function pulledDigest(output) {
  const matches = [...String(output).matchAll(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/gm)];
  assert.equal(matches.length, 1, 'Docker pull did not report exactly one immutable image digest.');
  return matches[0][1];
}

/** Resolve the mutable branch aliases once, then pass only digest references to Compose. */
export async function pinStagingImages(runDocker, expectedRevision) {
  assert.match(expectedRevision, /^[a-f0-9]{40}$/);
  const pinned = {};
  for (const service of services) {
    const repository = `${imageNamespace}/${service}`;
    const pulled = await runDocker(['pull', `${repository}:staging`]);
    const reference = `${repository}@${pulledDigest(pulled.stdout)}`;
    const inspection = JSON.parse((await runDocker(['image', 'inspect', reference])).stdout);
    assert.ok(Array.isArray(inspection) && inspection.length === 1, `Invalid ${service} image inspection.`);
    assert.match(inspection[0].Id ?? '', /^sha256:[a-f0-9]{64}$/, `Invalid ${service} image ID.`);
    assert.equal(
      inspection[0].Config?.Labels?.['org.opencontainers.image.revision'],
      expectedRevision,
      `${service} staging image does not match the checked-out commit.`,
    );
    pinned[`RIVET_${service.toUpperCase()}_IMAGE`] = reference;
  }
  // The production API image runs both processes. Verify its required entrypoint
  // before any existing Compose container is recreated.
  await runDocker([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--entrypoint',
    'sh',
    pinned.RIVET_API_IMAGE,
    '-c',
    'test -f /opt/rivet/backend-supervisor.mjs',
  ]);
  return pinned;
}

function realDirectory(source, label) {
  assert.ok(path.isAbsolute(source ?? ''), `${label} must resolve to an absolute host path.`);
  assert.ok(statSync(source).isDirectory(), `${label} must be an existing directory.`);
  return realpathSync(source);
}

function sourceFor(volumes, target, label) {
  const matches = volumes.filter((volume) => volume.target === target);
  assert.equal(matches.length, 1, `${label} must mount ${target} exactly once.`);
  assert.equal(matches[0].type, 'bind', `${label} must bind-mount ${target}.`);
  assert.notEqual(matches[0].read_only, true, `${label} must be writable at ${target}.`);
  return realDirectory(matches[0].source, `${label} ${target}`);
}

function namedVolume(config, service, target) {
  const volumes = config.services[service]?.volumes ?? [];
  const matches = volumes.filter((volume) => volume.target === target);
  assert.equal(matches.length, 1, `${service} must mount ${target} exactly once.`);
  assert.equal(matches[0].type, 'volume', `${service} must use a named volume at ${target}.`);
  const name = config.volumes?.[matches[0].source]?.name;
  assert.ok(name, `${service} ${target} has no resolved named volume.`);
  return name;
}

/** Check the rendered Compose plan against the running VM's complete data identity. */
export function assertStagingDataMounts(config, environment, previousApiInspection) {
  const servicesConfig = config?.services;
  assert.ok(servicesConfig?.api && servicesConfig['filesystem-artifacts-init'], 'Missing staging backend services.');
  assert.ok(previousApiInspection?.Mounts, 'Staging requires an existing API container to verify data continuity.');
  for (const [target, key] of artifactMounts) {
    const expected = realDirectory(environment[key], key);
    for (const service of ['api', 'filesystem-artifacts-init']) {
      assert.equal(
        sourceFor(servicesConfig[service].volumes ?? [], target, service),
        expected,
        `${service} ${target} does not use ${key}.`,
      );
    }
    const previous = previousApiInspection.Mounts.filter((mount) => mount.Destination === target);
    assert.equal(previous.length, 1, `Existing backend has no unambiguous ${target} mount.`);
    assert.equal(previous[0].Type, 'bind', `Existing backend must bind-mount ${target}.`);
    assert.equal(
      realDirectory(previous[0].Source, `Existing backend ${target}`),
      expected,
      `Staging would change the existing ${target} data mount. Refusing to recreate the backend.`,
    );
  }
  for (const target of stateVolumeTargets) {
    const expected = namedVolume(config, 'api', target);
    const previous = previousApiInspection.Mounts.filter((mount) => mount.Destination === target);
    assert.equal(previous.length, 1, `Existing backend has no unambiguous ${target} volume.`);
    assert.equal(previous[0].Type, 'volume', `Existing backend must use a named volume at ${target}.`);
    assert.equal(previous[0].Name, expected, `Staging would change the existing ${target} data volume.`);
    if (target === '/data/rivet-app' || target === '/data/local-metadata') {
      assert.equal(
        namedVolume(config, 'filesystem-artifacts-init', target),
        expected,
        `filesystem-artifacts-init ${target} must use the API's data volume.`,
      );
    }
  }
}

export function singleContainerId(output) {
  const ids = output.trim().split(/\s+/).filter(Boolean);
  assert.ok(ids.length <= 1, 'Multiple existing API containers found; refusing staging deployment.');
  if (ids.length) assert.match(ids[0], /^[a-f0-9]{12,64}$/, 'Invalid existing API container ID.');
  return ids[0] ?? null;
}

export function assertPinnedComposeImages(config, pinned) {
  const expected = {
    proxy: pinned.RIVET_PROXY_IMAGE,
    web: pinned.RIVET_WEB_IMAGE,
    api: pinned.RIVET_API_IMAGE,
    'filesystem-artifacts-init': pinned.RIVET_API_IMAGE,
  };
  for (const [service, image] of Object.entries(expected)) {
    assert.equal(config?.services?.[service]?.image, image, `${service} would not use its verified staging digest.`);
  }
}
