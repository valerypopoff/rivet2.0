import fs from 'node:fs';

/** Test-only API-server serialization. Never steal/unlink another owner's lock. */
export function acquireFixtureFileLock(
  file,
  {
    io = fs,
    platform = process.platform,
    now = Date.now,
    wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10),
    timeoutMs = 10000,
  } = {},
) {
  const started = now();
  let absentSince;
  while (true) {
    try {
      return io.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST' && !(platform === 'win32' && error.code === 'EPERM')) throw error;
      let stat;
      try {
        stat = io.lstatSync(file);
      } catch (readError) {
        if (readError.code !== 'ENOENT') throw readError;
      }
      // Windows can deny open while another handle finishes deleting the lock,
      // then report ENOENT to lstat. Bound that grace; persistent denial retains
      // its original error and never authorizes stealing/deleting a lock.
      if (error.code === 'EPERM' && !stat) {
        absentSince ??= now();
        if (now() - absentSince >= Math.min(100, timeoutMs)) throw error;
      } else absentSince = undefined;
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('Unsafe fixture lock path.');
      if (now() - started >= timeoutMs) throw Error('Timed out waiting for fixture state lock; owner retained.');
      wait();
    }
  }
}
