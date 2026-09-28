import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertFreshRehearsalResources,
  assertOwnedRehearsalCompose,
  assertRehearsalEnvironment,
  pinRehearsalImages,
  REHEARSAL_PHASES,
  assertRehearsalPhases,
  readRehearsalPhases,
} from './local-upgrade-rehearsal-safety.mjs';
import { createFixtureRegistry, fixturePackage } from './local-upgrade-fixture-registry.mjs';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run as runRehearsalCommand } from './local-upgrade-image-rehearsal.mjs';

test('rehearsal command waits for drained pipes and retains only a bounded output tail', async () => {
  const marker = 'generated-final-output-marker';
  const result = await runRehearsalCommand(
    process.execPath,
    ['-e', `process.stdout.write('x'.repeat(2*1048576)+${JSON.stringify(marker)},()=>process.exit(0));`],
    process.env,
  );
  assert.equal(result.code, 0);
  assert.equal(result.output.length, 1048576);
  assert.ok(result.output.endsWith(marker));
});

test('rehearsal command deadlines cannot become successful evidence even if termination exits zero', async () => {
  const args = ['-e', "process.on('SIGTERM',()=>process.exit(0));console.log('READY');setInterval(()=>{},1000);"];
  await assert.rejects(runRehearsalCommand(process.execPath, args, process.env, false, 750), /timed out/);
  const result = await runRehearsalCommand(process.execPath, args, process.env, true, 750);
  assert.equal(result.code, 1);
  assert.ok(result.output.includes('READY'));
});

test(
  'rehearsal command force-stops a foreground process that ignores SIGTERM',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runRehearsalCommand(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000);"],
      process.env,
      true,
      750,
    );
    assert.equal(result.code, 1);
    assert.ok(result.output.includes('READY'));
  },
);

test('phase evidence requires actual passed receipts, unique names and valid timestamps', () => {
  const receipts = REHEARSAL_PHASES.map((name) => ({ name, status: 'passed', checkedAt: '2026-09-28T12:00:00.000Z' }));
  assertRehearsalPhases(receipts, true);
  assert.throws(() => assertRehearsalPhases(receipts.slice(1), true));
  assert.throws(() => assertRehearsalPhases([...receipts, receipts[0]]));
  for (const change of [
    { status: 'not-run' },
    { status: 'failed' },
    { checkedAt: 'not-a-date' },
    { name: 'unknown' },
  ]) {
    assert.throws(() => assertRehearsalPhases([{ ...receipts[0], ...change }]));
  }
});

test('phase reader refuses symlinks and malformed evidence without following foreign files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-phase-evidence-'));
  try {
    const file = path.join(root, 'phases.json');
    assert.deepEqual(await readRehearsalPhases(file), []);
    await fs.writeFile(file, '[]');
    assert.deepEqual(await readRehearsalPhases(file), []);
    await fs.writeFile(file, '[{"name":"conversion","status":"not-run"}]');
    await assert.rejects(readRehearsalPhases(file));
    await fs.writeFile(file, '[]');
    const link = path.join(root, 'linked');
    // Windows directory junctions require no symlink privilege.
    await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readRehearsalPhases(path.join(link, 'phases.json')));
    await assert.rejects(readRehearsalPhases(path.join(link, 'missing.json')));
    await fs.unlink(link);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('manifest configuration cannot redirect Docker or inject host Node options', () => {
  assertRehearsalEnvironment({ RIVET_PORT: '127.0.0.1:23456', HTTP_PROXY: '' });
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'NODE_OPTIONS', 'COMPOSE_FILE', 'PATH'])
    assert.throws(() => assertRehearsalEnvironment({ [key]: 'unsafe' }));
});

function fixture() {
  const project = 'rivet-local-upgrade-rehearsal-12345678-1234-1234-1234-123456789abc';
  const id = 'sha256:' + 'a'.repeat(64);
  const config = {
    project,
    port: 23456,
    registryScript: '/owned/registry.mjs',
    images: { api: { id }, web: { id }, proxy: { id } },
  };
  const model = {
    name: project,
    volumes: { data: { name: project + '_data' } },
    networks: {
      default: { name: project + '_default', internal: true },
      edge: { name: project + '_edge' },
    },
    services: Object.fromEntries(
      ['api', 'web', 'proxy', 'filesystem-artifacts-init', 'fixture-registry'].map((name) => [
        name,
        {
          image: id,
          networks: name === 'proxy' ? { default: {}, edge: {} } : { default: {} },
          volumes:
            name === 'fixture-registry'
              ? [{ type: 'bind', source: config.registryScript, target: '/fixture-registry.mjs', read_only: true }]
              : [{ type: 'volume', source: 'data' }],
          ports: name === 'proxy' ? [{ host_ip: '127.0.0.1', published: '23456', target: 8080 }] : [],
        },
      ]),
    ),
  };
  return { config, model };
}
test('only the project-owned isolated fixture model is accepted', () => {
  const { config, model } = fixture();
  model.networks.default.ipam = {};
  assertOwnedRehearsalCompose(config, model);
});

test('backup tools are accepted only at their exact read-only fixture bindings', () => {
  const { config, model } = fixture();
  const mount = {
    type: 'bind',
    source: path.join(path.dirname(config.registryScript), 'local-upgrade-backup.mjs'),
    target: '/fixture-tools/local-upgrade-backup.mjs',
    read_only: true,
  };
  model.services.api.volumes.push(mount);
  assertOwnedRehearsalCompose(config, model);
  for (const change of [
    { read_only: false },
    { source: '/prod/local-upgrade-backup.mjs' },
    { target: '/fixture-tools/unreviewed.mjs' },
    { target: '/tools/local-upgrade-backup.mjs' },
  ]) {
    const changed = structuredClone(model);
    Object.assign(changed.services.api.volumes.at(-1), change);
    assert.throws(() => assertOwnedRehearsalCompose(config, changed));
  }
  const changed = structuredClone(model);
  changed.services.web.volumes.push(mount);
  assert.throws(() => assertOwnedRehearsalCompose(config, changed));
});

test('existing prefixed volumes or networks are not reusable disposable resources', () => {
  const { model } = fixture();
  assertFreshRehearsalResources(model, { volumes: [], networks: [] });
  assert.throws(() => assertFreshRehearsalResources(model, { volumes: [model.volumes.data.name], networks: [] }));
  assert.throws(() => assertFreshRehearsalResources(model, { volumes: [], networks: [model.networks.default.name] }));
});
for (const [name, change] of [
  [
    'fixed-name volume',
    (m) => {
      m.volumes.data.name = 'ops_data';
    },
  ],
  [
    'external volume',
    (m) => {
      m.volumes.data.external = true;
    },
  ],
  [
    'host-backed volume',
    (m) => {
      m.volumes.data.driver_opts = { device: '/prod' };
    },
  ],
  [
    'foreign bind',
    (m) => {
      m.services.api.volumes = [{ type: 'bind', source: '/prod', target: '/workflows' }];
    },
  ],
  [
    'host-backed secret',
    (m) => {
      m.secrets = { host: { file: '/prod.env' } };
    },
  ],
  [
    'host-backed config',
    (m) => {
      m.configs = { host: { file: '/prod.conf' } };
    },
  ],
  [
    'implicit Docker API socket',
    (m) => {
      m.services.api.use_api_socket = true;
    },
  ],
  [
    'lifecycle hook',
    (m) => {
      m.services.proxy.post_start = [{ command: 'unsafe' }];
    },
  ],
  [
    'foreign volume',
    (m) => {
      m.services.api.volumes = [{ type: 'volume', source: 'ops_data' }];
    },
  ],
  [
    'mutable image',
    (m) => {
      m.services.api.image = 'api:latest';
    },
  ],
  [
    'public port',
    (m) => {
      m.services.proxy.ports[0].host_ip = '0.0.0.0';
    },
  ],
  [
    'backend edge network',
    (m) => {
      m.services.api.networks.edge = {};
    },
  ],
  [
    'external network',
    (m) => {
      m.networks.default.external = true;
    },
  ],
  [
    'host namespace',
    (m) => {
      m.services.api.network_mode = 'host';
    },
  ],
])
  test(`fixture creation and cleanup reject ${name}`, () => {
    const { config, model } = fixture();
    change(model);
    assert.throws(() => assertOwnedRehearsalCompose(config, model));
  });
test('image tags resolve to immutable IDs and mismatched revisions are refused', () => {
  const image = {
    Id: 'sha256:' + 'b'.repeat(64),
    RepoDigests: ['repo@sha256:' + 'c'.repeat(64)],
    Config: { Labels: { 'org.opencontainers.image.revision': 'd'.repeat(40) } },
  };
  const images = { api: image, web: image, proxy: image };
  assert.equal(pinRehearsalImages(images).api.id, image.Id);
  assert.throws(() =>
    pinRehearsalImages({
      ...images,
      web: { ...image, Config: { Labels: { 'org.opencontainers.image.revision': 'e'.repeat(40) } } },
    }),
  );
  assert.throws(() => pinRehearsalImages({ ...images, web: { ...image, Config: {} } }));
  assert.doesNotThrow(() => pinRehearsalImages(images, 'd'.repeat(40)));
  assert.throws(() => pinRehearsalImages(images, 'e'.repeat(40)));
});
test('offline registry serves deterministic real package archives and refuses other packages', async () => {
  const server = createFixtureRegistry();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const manifest = await (await fetch(base + '/example')).json();
    assert.deepEqual(Object.keys(manifest.versions), ['1.0.0', '2.0.0']);
    assert.equal((await fetch(base + '/other')).status, 404);
    for (const version of ['1.0.0', '2.0.0']) {
      const bytes = Buffer.from(await (await fetch(base + `/example/-/example-${version}.tgz`)).arrayBuffer());
      assert.deepEqual(bytes, fixturePackage(version));
      assert.ok(gunzipSync(bytes).includes(Buffer.from(`module.exports=${version === '1.0.0' ? 42 : 84};`)));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
