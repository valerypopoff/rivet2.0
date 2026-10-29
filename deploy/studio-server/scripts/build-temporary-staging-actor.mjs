import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function prepareTemporaryActorContext(source, sha, context) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  // A clean working tree does not cover Git metadata. Never copy the host's
  // template files or execute its hooks while assembling the image context.
  const template = path.join(context, 'empty-git-template');
  await fs.mkdir(template, { mode: 0o700 });
  const git = (args, options) => execFileSync('git', ['-c', `core.hooksPath=${template}`, ...args], options);
  assert.equal(git(['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), sha);
  assert.equal(
    git(['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(),
    '',
    'Build an exact clean published candidate',
  );
  const checkout = path.join(context, 'source');
  // The context is consumed on Linux even when prepared on Windows. Do not let
  // the control host's autocrlf preference rewrite the exact committed bytes.
  git(
    [
      'clone',
      `--template=${template}`,
      '--config',
      'core.autocrlf=false',
      '--no-local',
      '--depth',
      '1',
      pathToFileURL(source).href,
      checkout,
    ],
    { stdio: 'pipe' },
  );
  git(['checkout', '--detach', sha], { cwd: checkout, stdio: 'pipe' });
  git(['config', '--remove-section', 'remote.origin'], { cwd: checkout, stdio: 'pipe' });
  assert.equal(git(['rev-list', '--count', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), '1');
  assert.equal(git(['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).trim(), '');
  await fs.copyFile(
    path.join(checkout, 'deploy/studio-server/images/qualification/Dockerfile'),
    path.join(context, 'Dockerfile'),
  );
}
export async function buildTemporaryStagingActor(sha, tag) {
  assert.match(tag ?? '', /^[a-z0-9./_-]+:[a-zA-Z0-9._-]+$/);
  const context = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-actor-build-'));
  try {
    await prepareTemporaryActorContext(root, sha, context);
    const result = spawnSync(
      'docker',
      ['build', '--platform=linux/amd64', '--build-arg', `SOURCE_SHA=${sha}`, '--tag', tag, context],
      { stdio: 'inherit' },
    );
    assert.equal(result.status, 0, 'Qualification actor build failed');
    console.log('Local actor built. Inspect/publish separately and pin its registry digest before staging admission.');
  } finally {
    assert.equal(path.dirname(context), path.resolve(os.tmpdir()));
    assert.ok(path.basename(context).startsWith('rivet-actor-build-'));
    await fs.rm(context, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildTemporaryStagingActor(process.argv[2], process.argv[3]);
