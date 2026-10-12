import fs from 'node:fs/promises';
import path from 'node:path';

/** Normalize only an already verified extraction, never the original backup or a live runtime root. */
export async function normalizeExtractedRuntimeLayout(root: string): Promise<void> {
  const marker = path.join(root, 'active-release');
  const stat = await fs.lstat(marker).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256)
    throw new Error('Invalid legacy runtime release marker.');
  const id = (await fs.readFile(marker, 'utf8')).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid legacy runtime release identity.');
  const current = path.join(root, 'current');
  if (
    await fs
      .lstat(current)
      .then(() => true)
      .catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })
  )
    throw new Error('Ambiguous legacy runtime release layout.');
  const releases = path.join(root, 'releases');
  const active = path.join(releases, id);
  for (const directory of [root, releases, active, path.join(active, 'node_modules')]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(directory)) !== path.resolve(directory))
      throw new Error('Unsafe legacy runtime release directory.');
  }
  // Rename removes an entry from releases as well as adding one to root.
  // Archives may legitimately preserve read-only directory modes.
  for (const directory of [root, releases]) {
    const stat = await fs.stat(directory);
    await fs.chmod(directory, stat.mode | 0o700);
  }
  await fs.rename(active, current);
  await fs.unlink(marker);
  // Inactive release entries are not imported and are left in the owned extraction until normal scratch cleanup.
}
