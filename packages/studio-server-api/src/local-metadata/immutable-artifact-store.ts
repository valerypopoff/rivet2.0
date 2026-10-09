import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstatSync, unlinkSync } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { syncDirectory, syncFileDescriptor } from '../routes/workflows/filesystem-transaction-primitives.js';

export type LocalArtifact = { hash: string; size: number };

/**
 * Immutable artifact storage for the local SQLite metadata backend. A caller may
 * commit a reference to an artifact only after putBytes/putFile has resolved.
 * Physical collection is available only to the catalog while it holds the
 * SQLite writer lock and has checked every authoritative reference.
 */
export class ImmutableLocalArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async putBytes(bytes: Uint8Array): Promise<LocalArtifact> {
    const stable = Buffer.from(bytes);
    return this.#put(async (write) => {
      await write(stable);
    });
  }

  async putFile(sourcePath: string): Promise<LocalArtifact> {
    const before = await fs.lstat(sourcePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Local artifact source must be a regular file.');
    return this.#put(async (write) => {
      const source = await fs.open(sourcePath, 'r');
      try {
        const opened = await source.stat();
        if (!opened.isFile() || !sameSourceFile(before, opened)) {
          throw new Error('Local artifact source changed before it could be copied.');
        }
        for await (const chunk of source.createReadStream({ autoClose: false })) await write(chunk);
        const after = await source.stat();
        const afterPath = await fs.lstat(sourcePath);
        if (!sameSourceFile(opened, after) || !afterPath.isFile() || !sameSourceFile(opened, afterPath)) {
          throw new Error('Local artifact source changed while it was copied.');
        }
      } finally {
        await source.close();
      }
    });
  }

  async read(hash: string, expectedSize?: number): Promise<Buffer> {
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0))
      throw new Error('Invalid local artifact expected size.');
    const filePath = this.#artifactPath(hash);
    const bytes = await this.#withStableFile(filePath, hash, (handle) => handle.readFile(), expectedSize);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new Error(`Local artifact ${hash} failed its checksum.`);
    }
    return bytes;
  }

  /** Called synchronously inside the catalog's write transaction. A collector
   * may have removed an old orphan after preparation but before this lock. */
  assertPresent(artifact: LocalArtifact): void {
    const file = this.#artifactPath(artifact.hash);
    for (const directory of [this.#root, path.dirname(file)]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe local artifact directory.');
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size)
      throw new Error('Prepared local artifact is missing or changed; retry the operation.');
  }

  async listCollectionCandidates(options: { before: number; after?: string; limit: number }) {
    const candidates: LocalArtifact[] = [];
    let cursor = options.after ?? '';
    let scanned = 0;
    try {
      await this.#assertDirectory(this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { candidates, cursor: '' };
      throw error;
    }
    // Shards and object names are bounded, validated and sorted. A cursor
    // prevents protected objects at the start from starving later orphans.
    for (const shard of (await fs.readdir(this.#root)).filter((name) => /^[a-f0-9]{2}$/.test(name)).sort()) {
      if (cursor && shard < cursor.slice(0, 2)) continue;
      const directory = path.join(this.#root, shard);
      await this.#assertDirectory(directory);
      for (const hash of (await fs.readdir(directory)).sort()) {
        if (!/^[a-f0-9]{64}$/.test(hash) || !hash.startsWith(shard) || hash <= cursor) continue;
        cursor = hash;
        const stat = await fs.lstat(this.#artifactPath(hash));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe local artifact object.');
        if (stat.mtimeMs <= options.before) candidates.push({ hash, size: stat.size });
        if (++scanned >= options.limit) return { candidates, cursor };
      }
    }
    return { candidates, cursor: '' };
  }

  /** The catalog must hold BEGIN IMMEDIATE and exclude referenced hashes. */
  removeUnreferenced(artifact: LocalArtifact, before: number): boolean {
    try {
      this.assertPresent(artifact);
      const file = this.#artifactPath(artifact.hash);
      if (lstatSync(file).mtimeMs > before) return false;
      unlinkSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async #put(produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>): Promise<LocalArtifact> {
    await this.#ensureDirectory(this.#root);
    const staging = path.join(this.#root, '.staging');
    await this.#ensureDirectory(staging);
    const temporaryPath = path.join(staging, randomUUID());
    const temporary = await fs.open(temporaryPath, 'wx', 0o600);
    const digest = createHash('sha256');
    let size = 0;
    try {
      try {
        await produce(async (chunk) => {
          digest.update(chunk);
          size += chunk.byteLength;
          if (!Number.isSafeInteger(size)) throw new Error('Local artifact exceeds the supported size.');
          await temporary.writeFile(chunk);
        });
        await syncFileDescriptor(temporary.fd);
      } finally {
        await temporary.close();
      }
      const hash = digest.digest('hex');
      await this.#verifyFile(temporaryPath, hash, size);
      const shard = path.join(this.#root, hash.slice(0, 2));
      await this.#ensureDirectory(shard);
      const destination = this.#artifactPath(hash);
      try {
        // A hard link publishes the fully synced inode without replacing an
        // existing object. A concurrent writer can only win with the same hash.
        await fs.link(temporaryPath, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.#verifyFile(destination, hash, size);
      }
      // A retry may race the original publisher before its directory sync.
      // Every successful caller establishes durability, including EEXIST.
      await syncDirectory(shard);
      return { hash, size };
    } finally {
      // An orphaned staging file is disposable; cleanup must not make a
      // successfully published artifact appear to have failed.
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  #artifactPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid local artifact hash.');
    return path.join(this.#root, hash.slice(0, 2), hash);
  }

  async #ensureDirectory(directory: string): Promise<void> {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Make every newly created ancestor durable before creating its child.
        // Recursive mkdir alone does not persist each intermediate entry.
        await this.#ensureDirectory(path.dirname(directory));
        await this.#ensureDirectory(directory);
        return;
      }
      if (code !== 'EEXIST') throw error;
    }
    await this.#assertDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }

  async #assertDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Local artifact path is not a real directory: ${directory}`);
    }
  }

  async #verifyFile(filePath: string, hash: string, size: number): Promise<void> {
    const digest = createHash('sha256');
    await this.#withStableFile(
      filePath,
      hash,
      async (handle) => {
        for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
      },
      size,
    );
    if (digest.digest('hex') !== hash) throw new Error(`Local artifact ${hash} failed its checksum.`);
  }

  async #withStableFile<T>(
    filePath: string,
    hash: string,
    read: (handle: FileHandle) => Promise<T>,
    size?: number,
  ): Promise<T> {
    await this.#assertDirectory(this.#root);
    await this.#assertDirectory(path.dirname(filePath));
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || (size !== undefined && before.size !== size)) {
      throw new Error(`Local artifact ${hash} is not a regular file or has an unexpected size.`);
    }
    const handle = await fs.open(filePath, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameArtifactFile(before, opened)) {
        throw new Error(`Local artifact ${hash} changed before it could be read.`);
      }
      const result = await read(handle);
      const after = await handle.stat();
      const afterPath = await fs.lstat(filePath);
      await this.#assertDirectory(this.#root);
      await this.#assertDirectory(path.dirname(filePath));
      if (
        !sameArtifactFile(opened, after) ||
        !afterPath.isFile() ||
        afterPath.isSymbolicLink() ||
        !sameArtifactFile(opened, afterPath)
      ) {
        throw new Error(`Local artifact ${hash} changed while it was read.`);
      }
      return result;
    } finally {
      await handle.close();
    }
  }
}

function sameSourceFile(left: Stats, right: Stats): boolean {
  return sameArtifactFile(left, right) && left.ctimeMs === right.ctimeMs;
}

function sameArtifactFile(left: Stats, right: Stats): boolean {
  // Publishing/removing staging hard links changes ctime, not artifact bytes.
  // Size/mtime and inode checks are paired with the full checksum on every read.
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
