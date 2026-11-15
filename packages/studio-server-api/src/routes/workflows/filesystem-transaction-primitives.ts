import { fsync as fsyncCallback } from 'node:fs';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Promote a frozen control record. The caller owns staging, durability and
 * cleanup; only a known Windows sharing failure retries, never the operation. */
export async function replaceControlFile(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, destination);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt === 4)
        throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}

export function syncFileDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsyncCallback(descriptor, (error) => (error ? reject(error) : resolve()));
  });
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await syncFileDescriptor(handle.fd);
  } catch (error) {
    // Windows does not consistently support fsync on directory descriptors.
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
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
