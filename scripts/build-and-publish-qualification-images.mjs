import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildTemporaryStagingActor } from '../deploy/studio-server/scripts/build-temporary-staging-actor.mjs';
import { publishQualificationImages, runPublicationCommand as run } from './qualification-image-publication.mjs';

// Hosted CI builds the same committed source that the in-cluster actor verifies.
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
assert.ok(['workflow_dispatch', 'push', 'schedule'].includes(process.env.GITHUB_EVENT_NAME));
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-publish-'));
try {
  const actor = `rivet-qualification:${process.env.GITHUB_SHA}`;
  await buildTemporaryStagingActor(process.env.GITHUB_SHA, actor);
  const minio = 'quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e';
  run('docker', ['pull', '--platform=linux/amd64', minio], { stdio: 'inherit' });
  for (const [name, image] of [
    ['actor', actor],
    ['minio', minio],
  ])
    run('docker', ['save', '--output', path.join(directory, `${name}.tar`), image], { stdio: 'inherit' });
  const sha = async (name) => {
    const hash = createHash('sha256');
    for await (const part of createReadStream(path.join(directory, `${name}.tar`))) hash.update(part);
    return hash.digest('hex');
  };
  await publishQualificationImages(
    {
      ...process.env,
      ACTOR_IMAGE_ID: run('docker', ['image', 'inspect', actor, '--format', '{{.Id}}']),
      ACTOR_ARCHIVE_SHA256: await sha('actor'),
      MINIO_ARCHIVE_SHA256: await sha('minio'),
    },
    { directory },
  );
} finally {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('rivet-publish-'));
  await fs.rm(directory, { recursive: true, force: true });
}
