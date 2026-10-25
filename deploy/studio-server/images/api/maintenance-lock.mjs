import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Linux flock on an open file description. Never unlink the lock or use a TTL.
 * Every maintenance descendant must inherit descriptor 3 before the parent closes it. */
export async function acquireMaintenanceLock(root, { flock = 'flock' } = {}) {
  if (process.platform !== 'linux') throw Error('Maintenance overlap requires Linux kernel file locks.');
  const directory = await fs.lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (await fs.realpath(root)) !== path.resolve(root))
    throw Error('Maintenance lock requires a real dedicated directory.');
  const file = path.join(root, 'housekeeping.lock');
  const handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw Error('Maintenance lock identity is unsafe.');
    const code = await new Promise((resolve, reject) => {
      const child = spawn(flock, ['-x', '-n', '3'], {
        stdio: ['ignore', 'ignore', 'inherit', handle.fd],
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code === 1) {
      await handle.close();
      return null;
    }
    if (code !== 0) throw Error('Kernel maintenance lock acquisition failed.');
    const current = await fs.lstat(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink())
      throw Error('Maintenance lock file changed during acquisition.');
    return { fd: handle.fd, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
