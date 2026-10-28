import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationEvidence, migrationCommitParents } from '../../deploy/studio-server/migration/evidence.mjs';

export function prepareMigrationHistory({ cwd = process.cwd(), evidence = migrationEvidence, execute } = {}) {
  for (const key of ['sourceCommit', 'sourceTree', 'importCommit', 'migrationCommit'])
    assert.match(evidence[key], /^[a-f0-9]{40}$/, `Migration evidence requires an exact ${key}.`);
  assert.match(evidence.importPrefix, /^[a-zA-Z0-9_/-]+$/);
  const git = execute ?? ((args, options) => execFileSync('git', args, { cwd, ...options }));
  const read = (args) =>
    git(args, {
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      // Partial clones can otherwise silently fetch missing commits during
      // inspection, bypassing the explicit depth/time-bounded fetch below.
      // The protocol fence also works on older Git without NO_LAZY_FETCH.
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
    }).trim();
  const inspect = () => {
    assert.deepEqual(migrationCommitParents(read(['cat-file', 'commit', evidence.migrationCommit])), [
      evidence.importCommit,
    ]);
    assert.equal(migrationCommitParents(read(['cat-file', 'commit', evidence.importCommit]))[1], evidence.sourceCommit);
    assert.equal(read(['rev-parse', `${evidence.sourceCommit}^{tree}`]), evidence.sourceTree);
    assert.equal(read(['rev-parse', `${evidence.importCommit}:${evidence.importPrefix}`]), evidence.sourceTree);
    // Trees, including descendants, must be present. The verifier compares blob
    // identities, not historical file contents; missing blobs need not be fetched.
    read(['ls-tree', '-r', `${evidence.importCommit}:${evidence.importPrefix}`]);
    read(['ls-tree', '-r', evidence.migrationCommit]);
  };
  try {
    inspect();
    return { fetched: false };
  } catch {
    // A depth-three fetch contains the migration, import and both import parents.
    // Never unshallow the checkout or fetch all remote branches/tags.
  }
  git(
    [
      '-c',
      'protocol.version=2',
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--filter=blob:none',
      '--depth=3',
      'origin',
      evidence.migrationCommit,
    ],
    { stdio: 'inherit', timeout: 180_000, killSignal: 'SIGKILL' },
  );
  inspect(); // Failed/incomplete transfers never authorize skipping the ledger.
  return { fetched: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = prepareMigrationHistory();
  console.log(`Migration Git evidence ready (${result.fetched ? 'bounded exact-commit fetch' : 'already present'}).`);
}
