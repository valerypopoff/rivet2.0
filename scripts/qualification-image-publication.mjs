import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputRoot = '/srv/rivet-private/image-publication';
export const minioImageId = 'sha256:9d668e47f1fc60ea49af4203deee87a657eb1aa0e2761fee2c7c2d1df282c880';
const minioRelease = 'RELEASE.2025-04-22T22-12-26Z';

export function publicationInputs(env) {
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Publication requires main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Publication requires explicit dispatch');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/);
  for (const key of ['ACTOR_ARCHIVE_SHA256', 'MINIO_ARCHIVE_SHA256']) assert.match(env[key] ?? '', /^[a-f0-9]{64}$/);
  assert.match(env.ACTOR_IMAGE_ID ?? '', /^sha256:[a-f0-9]{64}$/);
  return {
    sourceSha: env.GITHUB_SHA,
    namespace: `ghcr.io/${env.GITHUB_REPOSITORY.toLowerCase()}-studio-server`,
    tag: `${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    actorImageId: env.ACTOR_IMAGE_ID,
    actorArchiveSha256: env.ACTOR_ARCHIVE_SHA256,
    minioArchiveSha256: env.MINIO_ARCHIVE_SHA256,
  };
}

export async function verifyPublicationArchive(file, expectedHash) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  assert.ok((await fs.lstat(file)).isFile(), 'Publication archive must be a regular file, not a symlink');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  assert.equal(digest.digest('hex'), expectedHash, 'Publication archive differs from reviewed bytes');
}

export async function publishQualificationImages(env = process.env) {
  const input = publicationInputs(env);
  assert.equal(process.platform, 'linux');
  assert.ok(process.getuid() > 0, 'Use the non-root external runner');
  const run = (program, args, options = {}) =>
    execFileSync(program, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 720000, ...options }).trim();
  assert.equal(run('git', ['rev-parse', 'HEAD']), input.sourceSha);
  assert.equal(run('git', ['status', '--porcelain']), '', 'Publication checkout must be clean');
  assert.equal(await fs.realpath(inputRoot), inputRoot, 'Publication input root cannot be redirected');
  const actorArchive = path.join(inputRoot, 'actor.tar');
  const minioArchive = path.join(inputRoot, 'minio.tar');
  await verifyPublicationArchive(actorArchive, input.actorArchiveSha256);
  await verifyPublicationArchive(minioArchive, input.minioArchiveSha256);
  for (const archive of [actorArchive, minioArchive]) run('docker', ['load', '--input', archive]);
  const identity = (image) => run('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.equal(identity(input.actorImageId), input.actorImageId);
  assert.equal(identity(minioImageId), minioImageId);
  run('docker', [
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--entrypoint',
    'node',
    input.actorImageId,
    '--input-type=module',
    '-e',
    'import {verifyActorSource} from "/app/deploy/studio-server/images/qualification/verify-source.mjs"; await verifyActorSource("/app",process.argv[1]);',
    input.sourceSha,
  ]);
  assert.ok(
    run('docker', ['run', '--rm', '--pull=never', '--network=none', minioImageId, '--version']).includes(minioRelease),
  );
  const output = path.join(root, 'artifacts/qualification-image-publication');
  await fs.mkdir(output); // No stale scan or publication receipt can survive a retry.
  const scan = path.join(output, 'actor-scan');
  run(
    process.execPath,
    [
      path.join(root, 'scripts/ci/scan-container-images.mjs'),
      '--archive',
      actorArchive,
      '--platform',
      'linux/amd64',
      '--output',
      scan,
    ],
    { stdio: 'inherit' },
  );
  const assessment = JSON.parse(await fs.readFile(path.join(scan, 'linux-amd64/assessment.json')));
  const result = JSON.parse(await fs.readFile(path.join(scan, 'result.json')));
  assert.equal(result.passed, true);
  assert.equal(assessment.imageId, input.actorImageId);
  assert.equal(assessment.blockers.length, 0);
  // The private input directory is administrator-owned. Recheck after scanning
  // so changed archives cannot inherit the earlier source/hash admission.
  await verifyPublicationArchive(actorArchive, input.actorArchiveSha256);
  await verifyPublicationArchive(minioArchive, input.minioArchiveSha256);
  const publish = (id, name) => {
    const repository = `${input.namespace}/${name}`;
    const tag = `${repository}:${input.tag}`;
    run('docker', ['tag', id, tag]);
    const response = run('docker', ['push', tag]);
    const digest = /\bdigest: (sha256:[a-f0-9]{64})\b/.exec(response)?.[1];
    assert.ok(digest, 'Registry did not acknowledge an immutable image digest');
    assert.equal(identity(tag), id);
    const references = JSON.parse(run('docker', ['image', 'inspect', tag, '--format', '{{json .RepoDigests}}']));
    assert.ok(references.includes(`${repository}@${digest}`), 'Local registry receipt disagrees with push');
    return `${repository}@${digest}`;
  };
  const receipt = {
    protocol: 1,
    sourceSha: input.sourceSha,
    publishedAt: new Date().toISOString(),
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    actor: {
      image: publish(input.actorImageId, 'qualification'),
      imageId: input.actorImageId,
      archiveSha256: input.actorArchiveSha256,
      scannerImage: assessment.scannerImage,
      database: assessment.database,
    },
    minio: {
      image: publish(minioImageId, 'qualification-minio'),
      imageId: minioImageId,
      archiveSha256: input.minioArchiveSha256,
      release: minioRelease,
      upstream: 'quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e',
      source: `https://github.com/minio/minio/tree/${minioRelease}`,
    },
  };
  await fs.writeFile(path.join(output, 'publication.json'), JSON.stringify(receipt, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await publishQualificationImages();
