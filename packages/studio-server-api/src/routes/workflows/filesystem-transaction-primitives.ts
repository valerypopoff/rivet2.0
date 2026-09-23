import { fsync as fsyncCallback } from 'node:fs';
import fs from 'node:fs/promises';

function syncFileDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsyncCallback(descriptor, (error) => error ? reject(error) : resolve());
  });
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await syncFileDescriptor(handle.fd);
  } catch (error) {
    // Windows does not consistently support fsync on directory descriptors.
    if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function writeDurableExclusive(filePath: string, contents: Buffer | string, mode?: number): Promise<void> {
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(contents);
    if (mode !== undefined && process.platform !== 'win32') await handle.chmod(mode);
    await syncFileDescriptor(handle.fd);
  } finally {
    await handle.close();
  }
}
