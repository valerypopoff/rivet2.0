import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTemporaryStagingActor } from '../deploy/studio-server/scripts/build-temporary-staging-actor.mjs';
import { verifyActorSource } from '../deploy/studio-server/images/qualification/verify-source.mjs';
import { buildStagingJanitorRuntime } from '../deploy/studio-server/scripts/package-reusable-staging.mjs';
import { runRuntimeProbe } from '../deploy/studio-server/images/lib/run-runtime-probe.mjs';
import {
  publishQualificationImages,
  minioSourceImage,
  runPublicationCommand as run,
} from './qualification-image-publication.mjs';

// Hosted CI builds the same committed source that the in-cluster actor verifies.
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
assert.ok(['workflow_dispatch', 'push', 'schedule'].includes(process.env.GITHUB_EVENT_NAME));
assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
const root = fileURLToPath(new URL('../', import.meta.url));
await verifyActorSource(root, process.env.GITHUB_SHA);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-publish-'));
try {
  const actor = `rivet-qualification:${process.env.GITHUB_SHA}`;
  const janitor = `rivet-qualification-janitor:${process.env.GITHUB_SHA}`;
  run(
    'docker',
    ['build', '--platform=linux/amd64', '-f', 'deploy/studio-server/images/janitor/Dockerfile', '-t', janitor, '.'],
    { stdio: 'inherit' },
  );
  const janitorProgram = path.join(directory, 'janitor.mjs');
  await fs.writeFile(janitorProgram, (await buildStagingJanitorRuntime()).outputFiles[0].contents, { mode: 0o644 });
  runRuntimeProbe(
    janitor,
    [
      { source: janitorProgram, target: '/qualification/janitor.mjs' },
      {
        source: path.join(root, 'deploy/studio-server/images/lib/check-janitor-runtime.mjs'),
        target: '/check-janitor-runtime.mjs',
      },
    ],
    ['/check-janitor-runtime.mjs', '/qualification/janitor.mjs'],
  );
  await buildTemporaryStagingActor(process.env.GITHUB_SHA, actor);
  const minio = minioSourceImage;
  run('docker', ['pull', '--platform=linux/amd64', minio], { stdio: 'inherit' });
  for (const [name, image] of [
    ['actor', actor],
    ['janitor', janitor],
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
      JANITOR_IMAGE_ID: run('docker', ['image', 'inspect', janitor, '--format', '{{.Id}}']),
      JANITOR_ARCHIVE_SHA256: await sha('janitor'),
      MINIO_ARCHIVE_SHA256: await sha('minio'),
    },
    { directory },
  );
} finally {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('rivet-publish-'));
  await fs.rm(directory, { recursive: true, force: true });
}
