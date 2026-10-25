import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
      '--network',
      network,
      '--entrypoint',
      'node',
      '--mount',
      `type=bind,source=${path.resolve('deploy/studio-server/images/api')},target=/tests/api,readonly`,
      process.env.RIVET_HOUSEKEEPING_TEST_IMAGE || 'rivet-local/api:singleton-overlap-20261023',
      '/tests/api/fixtures/managed-housekeeping.mjs',
    ],
    { stdio: 'inherit', windowsHide: true },
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
