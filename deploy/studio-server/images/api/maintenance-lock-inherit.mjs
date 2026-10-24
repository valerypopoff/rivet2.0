import cp from 'node:child_process';
import { fstatSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// The maintenance API and its restore/npm/archive children retain the same open
// file description. Killing a supervisor cannot free the lock underneath them.
if (process.env.RIVET_MAINTENANCE_LOCK_INHERITED === '1') {
  const root = process.env.RIVET_LEGACY_RESTORE_ROOT || '/data/rivet-restore';
  const held = fstatSync(3),
    file = lstatSync(path.join(root, 'housekeeping.lock'));
  if (!held.isFile() || !file.isFile() || file.isSymbolicLink() || held.dev !== file.dev || held.ino !== file.ino)
    throw Error('Maintenance kernel lock descriptor is absent or changed.');
  // Re-locking the same open file description succeeds; a different owner's
  // lock cannot be stolen, even if environment variables claim ownership.
  const checked = cp.spawnSync('flock', ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
  if (checked.status !== 0) throw Error('Maintenance kernel ownership is not held by this process.');
  globalThis[Symbol.for('rivet.housekeeping.kernel-owner')] = true;
  const options = (value = {}) => {
    const stdio = Array.isArray(value.stdio) ? [...value.stdio] : Array(3).fill(value.stdio ?? 'pipe');
    if (stdio[3] && stdio[3] !== 3) throw Error('Maintenance child descriptor 3 is reserved.');
    stdio[3] = 3;
    return {
      ...value,
      stdio,
      env: {
        ...(value.env ?? process.env),
        RIVET_MAINTENANCE_LOCK_INHERITED: '1',
        RIVET_LEGACY_RESTORE_ROOT: root,
        // Preserve the caller's sanitization/options, adding only the mandatory
        // ownership preload rather than restoring the parent's entire environment.
        NODE_OPTIONS: `${(value.env ?? process.env).NODE_OPTIONS || ''} --import=${import.meta.url}`.trim(),
      },
    };
  };
  for (const name of ['spawn', 'spawnSync']) {
    const original = cp[name];
    cp[name] = (command, args, settings) =>
      Array.isArray(args) ? original(command, args, options(settings)) : original(command, [], options(args));
  }
  // Maintenance callers must use the audited spawn boundary. exec helpers can
  // silently replace stdio and drop ownership; fail closed rather than unlock.
  for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    cp[name] = () => {
      throw Error('Maintenance children must use lock-inheriting spawn/spawnSync.');
    };
  syncBuiltinESMExports();
}
