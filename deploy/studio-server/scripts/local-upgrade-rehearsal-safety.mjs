import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export const REHEARSAL_PROJECT = /^rivet-local-upgrade-rehearsal-[a-f0-9-]{36}$/;

// Preserve the deployment layout: the backup tool imports both its sibling
// snapshot planner and the UI-managed key/layout helper under images/api.
export const REHEARSAL_TOOLS = Object.freeze([
  'scripts/local-upgrade-backup.mjs',
  'scripts/local-upgrade-snapshot-plan.mjs',
  'images/api/local-upgrade-ui.mjs',
]);

export const REHEARSAL_PHASES = Object.freeze([
  'online-recovery',
  'offline-recovery',
  'conversion',
  'project-save-and-conflict',
  'publication-and-history',
  'settings-and-libraries',
  'recordings',
  'restart-persistence',
  'reference-integrity',
  'retained-source-proof',
  'web-app-policy',
  'operational-domains',
  'editor-libraries-and-removal',
  'post-resumption-backup-restore',
]);

export function assertRehearsalPhases(phases, complete = false) {
  assert.ok(Array.isArray(phases), 'Invalid rehearsal phase evidence.');
  const names = new Set();
  for (const phase of phases) {
    assert.ok(phase && typeof phase === 'object' && !Array.isArray(phase));
    assert.ok(REHEARSAL_PHASES.includes(phase.name), 'Unknown rehearsal evidence phase.');
    assert.equal(phase.status, 'passed', 'Phase assertions did not pass.');
    assert.ok(typeof phase.checkedAt === 'string' && Number.isFinite(Date.parse(phase.checkedAt)));
    assert.equal(new Date(phase.checkedAt).toISOString(), phase.checkedAt, 'Invalid phase timestamp.');
    assert.ok(!names.has(phase.name), 'Duplicate evidence phase.');
    names.add(phase.name);
  }
  if (complete) assert.equal(names.size, REHEARSAL_PHASES.length, 'Required assertions did not all run.');
}

export async function readRehearsalPhases(file) {
  await assertRealPath(path.dirname(file), true);
  try {
    await assertRealPath(file);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const phases = JSON.parse(await fs.readFile(file, 'utf8'));
  assertRehearsalPhases(phases);
  return phases;
}

export function assertRehearsalEnvironment(env) {
  assert.ok(env && typeof env === 'object' && !Array.isArray(env));
  assert.ok(
    Object.keys(env).every(
      (key) =>
        key.startsWith('RIVET_') ||
        /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)$/.test(key),
    ),
    'Rehearsal manifest may not override Docker or host command environment.',
  );
}

export function assertFreshRehearsalResources(model, resources) {
  for (const kind of ['volumes', 'networks']) {
    const existing = new Set(resources[kind]);
    for (const resource of Object.values(model[kind] || {}))
      assert.ok(!existing.has(resource.name), `Disposable ${kind} already exist; refusing reuse or cleanup.`);
  }
}

/** Resolve tags once. Compose receives immutable local IDs, never mutable tags. */
export function pinRehearsalImages(inspections, expectedRevision) {
  const result = {};
  for (const service of ['api', 'web', 'proxy']) {
    const image = inspections[service];
    assert.match(image?.Id ?? '', /^sha256:[a-f0-9]{64}$/);
    const revision = image.Config?.Labels?.['org.opencontainers.image.revision'] || null;
    if (revision !== null) assert.match(revision, /^[a-f0-9]{40}$/);
    result[service] = { id: image.Id, digests: [...(image.RepoDigests || [])].sort(), revision };
  }
  const revisions = new Set(
    Object.values(result)
      .map((image) => image.revision)
      .filter(Boolean),
  );
  assert.ok(revisions.size <= 1, 'Rehearsal images must have matching source revisions.');
  if (revisions.size)
    assert.ok(
      Object.values(result).every((image) => image.revision),
      'Mixed labelled/unlabelled images.',
    );
  if (expectedRevision !== undefined) {
    assert.match(expectedRevision, /^[a-f0-9]{40}$/);
    assert.ok(
      Object.values(result).every((image) => image.revision === expectedRevision),
      'Image provenance does not match the required CI revision.',
    );
  }
  return result;
}

export async function assertRealPath(file, directory = false) {
  const resolved = path.resolve(file);
  let cursor = resolved;
  while (true) {
    const stat = await fs.lstat(cursor);
    assert.ok(!stat.isSymbolicLink(), 'Rehearsal paths must not have symlink ancestors.');
    assert.ok(cursor === resolved && !directory ? stat.isFile() : stat.isDirectory(), 'Invalid rehearsal path.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    cursor = parent;
  }
}

/** Pure validation of the rendered model, also repeated before cleanup. */
export function assertOwnedRehearsalCompose(config, model) {
  assert.match(config.project, REHEARSAL_PROJECT);
  assert.equal(model.name, config.project);
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
  const services = ['api', 'web', 'proxy', 'filesystem-artifacts-init', 'fixture-registry'];
  assert.deepEqual(Object.keys(model.services).sort(), services.sort());
  assert.ok(
    !Object.keys(model.secrets || {}).length && !Object.keys(model.configs || {}).length,
    'Foreign config/secret mounts refused.',
  );
  for (const [name, volume] of Object.entries(model.volumes || {})) {
    assert.equal(volume.name, `${config.project}_${name}`, 'Unowned volume name.');
    assert.ok(!volume.external && !volume.driver_opts, 'External/host-backed volume refused.');
    assert.ok(!volume.driver || volume.driver === 'local');
  }
  assert.deepEqual(Object.keys(model.networks || {}).sort(), ['default', 'edge']);
  for (const [name, network] of Object.entries(model.networks)) {
    assert.equal(network.name, `${config.project}_${name}`);
    assert.ok(
      !network.external && !network.driver_opts && (!network.ipam || Object.keys(network.ipam).length === 0),
      'Unowned network configuration.',
    );
    assert.ok(!network.driver || network.driver === 'bridge');
    assert.equal(!!network.internal, name === 'default');
  }
  for (const [name, service] of Object.entries(model.services)) {
    assert.equal(
      service.image,
      config.images[name === 'fixture-registry' || name === 'filesystem-artifacts-init' ? 'api' : name].id,
    );
    assert.ok(!service.privileged && !service.network_mode && !service.pid && !service.devices && !service.cap_add);
    assert.ok(!service.container_name && !service.volumes_from && !service.extra_hosts);
    assert.ok(
      !service.secrets && !service.configs && !service.use_api_socket && !service.post_start && !service.pre_stop,
      'Implicit mounts or lifecycle hooks refused.',
    );
    assert.deepEqual(Object.keys(service.networks || {}).sort(), name === 'proxy' ? ['default', 'edge'] : ['default']);
    for (const mount of service.volumes || []) {
      if (mount.type === 'volume') assert.ok(Object.hasOwn(model.volumes, mount.source), 'Foreign volume source.');
      else if (mount.type === 'bind') {
        if (name === 'fixture-registry') {
          assert.equal(mount.source, config.registryScript);
          assert.equal(mount.target, '/fixture-registry.mjs');
        } else {
          assert.equal(name, 'api', 'Foreign bind mount.');
          const file = REHEARSAL_TOOLS.find((file) => mount.target === '/fixture-tools/' + file);
          assert.ok(file, 'Foreign fixture tool.');
          assert.equal(mount.source, path.join(path.dirname(config.registryScript), 'fixture-tools', file));
        }
        assert.equal(mount.read_only, true);
      } else assert.equal(mount.type, 'tmpfs');
    }
    const ports = service.ports || [];
    if (name === 'proxy') {
      assert.equal(ports.length, 1);
      assert.equal(ports[0].host_ip, '127.0.0.1');
      assert.equal(String(ports[0].published), String(config.port));
      assert.equal(ports[0].target, 8080);
    } else assert.equal(ports.length, 0, 'Only the fixture gateway may publish a port.');
  }
}
