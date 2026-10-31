import assert from 'node:assert/strict';
import test from 'node:test';
// test-style: fixture-read: Only temporary archive fixtures are read by this test.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  publicationInputs,
  verifyPublicationArchive,
  preparePublicationOutput,
  runPublicationCommand,
} from './qualification-image-publication.mjs';

const env = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REPOSITORY: 'Owner/Repo',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  ACTOR_IMAGE_ID: `sha256:${'b'.repeat(64)}`,
  ACTOR_ARCHIVE_SHA256: 'c'.repeat(64),
  MINIO_ARCHIVE_SHA256: 'd'.repeat(64),
};

test('real subprocesses support captured or inherited output while preserving failures', () => {
  assert.equal(
    runPublicationCommand(process.execPath, ['-e', 'console.log("  captured receipt  ")']),
    'captured receipt',
  );
  assert.equal(runPublicationCommand(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'inherit' }), '');
  assert.throws(() => runPublicationCommand(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'inherit' }), {
    status: 7,
  });
});

test('publication refuses branch/event confusion and command-shaped dispatch inputs before Docker access', () => {
  assert.equal(publicationInputs(env).namespace, 'ghcr.io/owner/repo-studio-server');
  for (const GITHUB_EVENT_NAME of ['push', 'schedule'])
    assert.equal(publicationInputs({ ...env, GITHUB_EVENT_NAME }).sourceSha, env.GITHUB_SHA);
  for (const change of [
    { GITHUB_REF: 'refs/heads/staging' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { ACTOR_IMAGE_ID: 'sha256:abc; echo injected' },
    { ACTOR_ARCHIVE_SHA256: '../archive' },
    { MINIO_ARCHIVE_SHA256: 'latest' },
    { GITHUB_REPOSITORY: 'other/repo/path' },
    { GITHUB_RUN_ID: '1;id' },
  ])
    assert.throws(() => publicationInputs({ ...env, ...change }));
});

test('actual archive bytes are checked, including post-admission mutation and non-file input', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-publish-archive-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'image.tar');
  const bytes = Buffer.from('reviewed archive fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(file, bytes);
  await verifyPublicationArchive(file, hash);
  await fs.appendFile(file, 'changed');
  await assert.rejects(verifyPublicationArchive(file, hash), /reviewed bytes/);
  await assert.rejects(verifyPublicationArchive(directory, hash), /regular file/);
});

test('a pristine runner can publish, while retained output blocks a second attempt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-publish-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = await preparePublicationOutput(root);
  const receipt = path.join(output, 'publication.json');
  await fs.writeFile(receipt, 'retained receipt');
  await assert.rejects(preparePublicationOutput(root), { code: 'EEXIST' });
  assert.equal(await fs.readFile(receipt, 'utf8'), 'retained receipt');
});
