import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensurePortAvailable } from './lib/docker-launcher.mjs';
import {
  assertPinnedComposeImages,
  assertStagingDataMounts,
  assertStagingCheckout,
  pinStagingImages,
  pulledDigest,
  singleContainerId,
} from './lib/staging-docker.mjs';

const revision = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);

test('staging requires its exact clean checkout before touching containers', () => {
  assert.equal(assertStagingCheckout({ branch: 'staging\n', revision, status: '' }), revision);
  assert.throws(() => assertStagingCheckout({ branch: 'main', revision, status: '' }), /staging Git branch/);
  assert.throws(
    () => assertStagingCheckout({ branch: 'staging', revision, status: ' M package.json' }),
    /clean tracked/,
  );
  assert.throws(() => assertStagingCheckout({ branch: 'staging', revision: 'bad', status: '' }), /valid Git commit/);
});

test('staging pins every matching alias to its inspected digest before Compose starts', async () => {
  const calls = [];
  const pinned = await pinStagingImages(async (args) => {
    calls.push(args);
    const reference = args.at(-1);
    if (args[0] === 'pull') return { stdout: `staging: Pulling\nDigest: ${digest}\nStatus: Downloaded\n` };
    if (args[0] === 'image')
      return {
        stdout: JSON.stringify([
          {
            Id: 'sha256:' + 'c'.repeat(64),
            RepoDigests: [reference],
            Config: { Labels: { 'org.opencontainers.image.revision': revision } },
          },
        ]),
      };
    return { stdout: '' };
  }, revision);
  assert.deepEqual(Object.keys(pinned).sort(), [
    'RIVET_API_IMAGE',
    'RIVET_EXECUTOR_IMAGE',
    'RIVET_PROXY_IMAGE',
    'RIVET_WEB_IMAGE',
  ]);
  assert.equal(pinned.RIVET_API_IMAGE, `ghcr.io/valerypopoff/rivet2.0-studio-server/api@${digest}`);
  assert.deepEqual(calls.at(-1).slice(0, 5), ['run', '--rm', '--network', 'none', '--read-only']);
  assert.ok(calls.every((args) => args[0] !== 'run' || args.includes(pinned.RIVET_API_IMAGE)));
});

test('staging refuses malformed or mismatched image provenance', async () => {
  assert.throws(() => pulledDigest('Status: Downloaded'), /exactly one immutable/);
  assert.throws(() => pulledDigest(`Digest: ${digest}\nDigest: ${digest}`), /exactly one immutable/);
  const calls = [];
  await assert.rejects(
    () =>
      pinStagingImages(async (args) => {
        calls.push(args);
        if (args[0] === 'pull') return { stdout: `Digest: ${digest}\n` };
        return {
          stdout: JSON.stringify([
            {
              Id: 'sha256:' + 'c'.repeat(64),
              RepoDigests: [args.at(-1)],
              Config: { Labels: { 'org.opencontainers.image.revision': 'd'.repeat(40) } },
            },
          ]),
        };
      }, revision),
    /does not match the checked-out commit/,
  );
  assert.ok(!calls.some((args) => args[0] === 'run'));
});

test('staging refuses an API image without the combined backend supervisor', async () => {
  await assert.rejects(
    () =>
      pinStagingImages(async (args) => {
        if (args[0] === 'pull') return { stdout: `Digest: ${digest}\n` };
        if (args[0] === 'image')
          return {
            stdout: JSON.stringify([
              {
                Id: 'sha256:' + 'c'.repeat(64),
                Config: { Labels: { 'org.opencontainers.image.revision': revision } },
              },
            ]),
          };
        throw Error('Combined backend supervisor missing');
      }, revision),
    /supervisor missing/,
  );
});

test('staging refuses changed artifact or named-volume mounts before recreation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rivet-staging-mounts-'));
  try {
    const folders = ['workflows', 'workflow-recordings', 'runtime-libraries', 'empty-workflows'];
    for (const folder of folders) mkdirSync(path.join(root, folder));
    const expected = {
      RIVET_WORKFLOWS_HOST_PATH: path.join(root, 'workflows'),
      RIVET_WORKFLOW_RECORDINGS_HOST_PATH: path.join(root, 'workflow-recordings'),
      RIVET_RUNTIME_LIBS_HOST_PATH: path.join(root, 'runtime-libraries'),
    };
    const artifactVolumes = [
      { type: 'bind', source: expected.RIVET_WORKFLOWS_HOST_PATH, target: '/workflows' },
      { type: 'bind', source: expected.RIVET_WORKFLOW_RECORDINGS_HOST_PATH, target: '/workflow-recordings' },
      { type: 'bind', source: expected.RIVET_RUNTIME_LIBS_HOST_PATH, target: '/data/runtime-libraries' },
    ];
    const namedVolumes = [
      { type: 'volume', source: 'rivet_workspace', target: '/workspace' },
      { type: 'volume', source: 'rivet_data', target: '/data/rivet-app' },
      {
        type: 'volume',
        source: 'rivet_data',
        target: '/home/rivet/.local/share/com.valerypopoff.rivet2',
      },
      { type: 'volume', source: 'rivet_local_metadata', target: '/data/local-metadata' },
    ];
    const volumes = [...artifactVolumes, ...namedVolumes];
    const config = {
      volumes: Object.fromEntries(namedVolumes.map((volume) => [volume.source, { name: `ops_${volume.source}` }])),
      services: {
        api: { volumes },
        'filesystem-artifacts-init': {
          volumes: [...artifactVolumes, ...namedVolumes.filter((volume) => volume.target !== '/workspace')],
        },
      },
    };
    const previous = {
      Mounts: volumes.map((volume) => ({
        Type: volume.type,
        Source: volume.source,
        Destination: volume.target,
        Name: volume.type === 'volume' ? `ops_${volume.source}` : '',
      })),
    };
    assert.doesNotThrow(() => assertStagingDataMounts(config, expected, previous));
    assert.throws(
      () =>
        assertStagingDataMounts(
          config,
          {
            ...expected,
            RIVET_WORKFLOWS_HOST_PATH: path.join(root, 'empty-workflows'),
          },
          previous,
        ),
      /does not use RIVET_WORKFLOWS_HOST_PATH/,
    );
    assert.throws(
      () =>
        assertStagingDataMounts(
          {
            ...config,
            services: {
              ...config.services,
              'filesystem-artifacts-init': {
                volumes: config.services['filesystem-artifacts-init'].volumes.map((volume) =>
                  volume.target === '/workflows' ? { ...volume, source: path.join(root, 'empty-workflows') } : volume,
                ),
              },
            },
          },
          expected,
          previous,
        ),
      /filesystem-artifacts-init \/workflows does not use/,
    );
    assert.throws(
      () =>
        assertStagingDataMounts(config, expected, {
          Mounts: previous.Mounts.map((mount) =>
            mount.Destination === '/workflows' ? { ...mount, Source: path.join(root, 'empty-workflows') } : mount,
          ),
        }),
      /would change the existing \/workflows data mount/,
    );
    assert.throws(() => assertStagingDataMounts(config, {}, previous), /absolute host path/);
    assert.throws(() => assertStagingDataMounts(config, expected, null), /requires an existing API container/);
    assert.throws(
      () =>
        assertStagingDataMounts(config, expected, {
          Mounts: previous.Mounts.map((mount) =>
            mount.Destination === '/data/local-metadata' ? { ...mount, Name: 'other_rivet_local_metadata' } : mount,
          ),
        }),
      /would change the existing \/data\/local-metadata data volume/,
    );
    assert.throws(
      () =>
        assertStagingDataMounts(
          {
            ...config,
            services: {
              ...config.services,
              'filesystem-artifacts-init': {
                volumes: config.services['filesystem-artifacts-init'].volumes.map((volume) =>
                  volume.target === '/data/rivet-app' ? { ...volume, source: 'rivet_workspace' } : volume,
                ),
              },
            },
          },
          expected,
          previous,
        ),
      /filesystem-artifacts-init \/data\/rivet-app must use the API's data volume/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staging refuses ambiguous existing API containers', () => {
  assert.equal(singleContainerId(''), null);
  assert.equal(singleContainerId('a'.repeat(64) + '\n'), 'a'.repeat(64));
  assert.throws(() => singleContainerId('a'.repeat(64) + '\n' + 'b'.repeat(64)), /Multiple existing API/);
});

test('staging refuses Compose image selectors that do not use pinned digests', () => {
  const pinned = {
    RIVET_PROXY_IMAGE: 'proxy@sha256:' + 'a'.repeat(64),
    RIVET_WEB_IMAGE: 'web@sha256:' + 'b'.repeat(64),
    RIVET_API_IMAGE: 'api@sha256:' + 'c'.repeat(64),
  };
  const services = {
    proxy: { image: pinned.RIVET_PROXY_IMAGE },
    web: { image: pinned.RIVET_WEB_IMAGE },
    api: { image: pinned.RIVET_API_IMAGE },
    'filesystem-artifacts-init': { image: pinned.RIVET_API_IMAGE },
  };
  assert.doesNotThrow(() => assertPinnedComposeImages({ services }, pinned));
  assert.throws(
    () => assertPinnedComposeImages({ services: { ...services, api: { image: 'api:latest' } } }, pinned),
    /api would not use its verified staging digest/,
  );
  assert.throws(
    () => assertPinnedComposeImages({ services: { ...services, 'filesystem-artifacts-init': {} } }, pinned),
    /filesystem-artifacts-init would not use its verified staging digest/,
  );
});

function failingServer(code) {
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit('error', Object.assign(new Error(code), { code })));
  return server;
}

test('a non-root Linux port-80 EACCES uses the listener table without hiding a real conflict', async () => {
  const options = {
    envFileLabel: '.env',
    label: 'prod-docker',
    platform: 'linux',
    createServer: () => failingServer('EACCES'),
  };
  await ensurePortAvailable(80, { ...options, probePrivilegedPort: async () => false });
  await assert.rejects(
    () => ensurePortAvailable(80, { ...options, probePrivilegedPort: async () => true }),
    /already in use/,
  );
  await assert.rejects(
    () =>
      ensurePortAvailable(80, {
        ...options,
        probePrivilegedPort: async () => {
          throw Error('ss unavailable');
        },
      }),
    /ss unavailable/,
  );
  await assert.rejects(
    () => ensurePortAvailable(8080, { ...options, probePrivilegedPort: async () => false }),
    /EACCES/,
  );
  await assert.rejects(
    () => ensurePortAvailable(80, { ...options, platform: 'win32', probePrivilegedPort: async () => false }),
    /EACCES/,
  );
  await assert.rejects(
    () => ensurePortAvailable(80, { ...options, createServer: () => failingServer('EADDRINUSE') }),
    /already in use/,
  );
});
