import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const providerFixture = process.argv[2] === '--provider-fixture';
assert.ok(
  process.argv.length === 2 || (process.argv.length === 3 && providerFixture),
  'Unknown managed fixture option',
);
const image = process.env.RIVET_HOUSEKEEPING_TEST_IMAGE || 'rivet-local/api:singleton-overlap-20261023';
if (providerFixture)
  assert.match(
    image,
    /^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/,
    'Provider fixture requires an explicit immutable cached API image',
  );
const helper = providerFixture
  ? (
      await build({
        entryPoints: ['deploy/studio-server/scripts/qualification/overlap-bundle-fixture.mjs'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        write: false,
        banner: {
          js: "import { createRequire } from 'node:module'; const require = createRequire('/app/packages/studio-server-api/package.json');",
        },
      })
    ).outputFiles[0].text
  : undefined;
const token = randomUUID(),
  network = `rivet-overlap-${token}`;
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
const owned = [];
docker(['network', 'create', '--label', `rivet.overlap.operation=${token}`, network]);
try {
  owned.push(
    docker([
      'run',
      '-d',
      '--network',
      network,
      '--network-alias',
      'db',
      '--label',
      `rivet.overlap.operation=${token}`,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=overlap',
      'postgres:16.8-alpine',
      ...(providerFixture ? ['-c', 'max_connections=200'] : []),
    ]),
  );
  owned.push(
    docker([
      'run',
      '-d',
      '--network',
      network,
      '--network-alias',
      'objects',
      '--label',
      `rivet.overlap.operation=${token}`,
      '-e',
      'MINIO_ROOT_USER=overlap',
      '-e',
      'MINIO_ROOT_PASSWORD=overlap-local-secret',
      'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z',
      'server',
      '/tmp/objects',
    ]),
  );
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      ...(providerFixture ? ['-i', '--pull', 'never', '-e', 'RIVET_HOUSEKEEPING_PROVIDER_FIXTURE=1'] : []),
      '--network',
      network,
      '--entrypoint',
      'node',
      '--mount',
      `type=bind,source=${path.resolve('deploy/studio-server/images/api')},target=/tests/api,readonly`,
      image,
      '/tests/api/fixtures/managed-housekeeping.mjs',
    ],
    { stdio: providerFixture ? ['pipe', 'inherit', 'inherit'] : 'inherit', input: helper, windowsHide: true },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const id of owned) {
    const label = docker(['inspect', '--format', '{{index .Config.Labels "rivet.overlap.operation"}}', id]);
    if (label !== token) throw Error('Local fixture container ownership changed; removal refused.');
    docker(['rm', '-f', id]);
  }
  docker(['network', 'rm', network]);
}
