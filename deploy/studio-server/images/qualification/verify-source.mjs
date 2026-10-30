import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// This is an actor packaging boundary, not a vulnerability-scanner exclusion.
// The native desktop backend is neither built nor executed by server/browser
// qualification. Its source and independent audit remain in the real repository.
export const actorExcludedSource = 'packages/app/src-tauri';
export const actorSparsePatterns = ['/*', `!/${actorExcludedSource}/`];

export async function verifyActorSource(root, sha) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  // Source admission is not a user's status display. Never execute a configured
  // filesystem-monitor hook, inspect a locally substituted commit, or let
  // status preferences hide extra source files.
  const git = (...args) =>
    execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trimEnd();
  assert.equal(git('rev-parse', 'HEAD'), sha, 'Actor source revision differs');
  assert.equal(await fs.realpath(git('rev-parse', '--show-toplevel')), await fs.realpath(root));
  const entries = git('ls-files', '-v', '-z').split('\0').filter(Boolean);
  const sparse = entries.filter((entry) => entry.startsWith('S ')).map((entry) => entry.slice(2));
  assert.ok(
    entries.every((entry) => /^(?:H|S) /.test(entry)),
    'Actor source cannot hide changes with index flags',
  );
  const enabled = git('config', '--get', '--default=false', 'core.sparseCheckout');
  if (enabled === 'true') {
    assert.deepEqual(
      git('sparse-checkout', 'list').split(/\r?\n/),
      actorSparsePatterns,
      'Unknown actor source projection',
    );
    const excluded = git('ls-tree', '-r', '--name-only', 'HEAD', '--', actorExcludedSource)
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(sparse.sort(), excluded.sort(), 'Actor projection hides required source');
    await assert.rejects(fs.lstat(path.join(root, actorExcludedSource)), { code: 'ENOENT' });
  } else {
    assert.equal(enabled, 'false', 'Unknown sparse checkout configuration');
    assert.deepEqual(sparse, [], 'Full source checkout cannot hide required files');
  }
  assert.equal(
    git('status', '--porcelain', '--untracked-files=all'),
    '',
    'Actor checkout must contain exact clean source',
  );
}
