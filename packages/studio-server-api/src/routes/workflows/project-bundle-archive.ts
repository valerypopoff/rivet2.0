import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { ProjectBundleError } from '@valerypopoff/rivet2-node';

/** One compressed archive, one consumed input at a time; no raw staging tree. */
export function createProjectBundleArchive(options: {
  archive: string;
  directory: string;
  signal: AbortSignal;
  scratchLimit: number;
  reserveBytes: number;
  retainedBytes(): number;
  progress(bytes: number): void;
}) {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const hash = createHash('sha256');
  let bytes = 0;
  let input: Readable | undefined;
  let failure: Error | undefined;
  let spaceCredit = 0;
  let checkedAt = 0;
  let bytesSinceCheck = 0;
  const checkSpace = async (length: number, force = false) => {
    if (force || spaceCredit < length || bytesSinceCheck >= 4 * 1024 * 1024 || Date.now() - checkedAt >= 1000) {
      const space = await fs.statfs(options.directory);
      // Allow for the sink's queued writes and small status-journal replacements.
      spaceCredit = space.bavail * space.bsize - options.reserveBytes - 64 * 1024;
      checkedAt = Date.now();
      bytesSinceCheck = 0;
    }
    if (spaceCredit < length) throw new ProjectBundleError('Not enough free scratch space to prepare this export.');
    spaceCredit -= length;
    bytesSinceCheck += length;
  };
  const guard = new Transform({
    readableHighWaterMark: 16 * 1024,
    writableHighWaterMark: 16 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      void (async () => {
        signal.throwIfAborted();
        if (options.retainedBytes() + bytes + chunk.length > options.scratchLimit)
          throw new ProjectBundleError(
            'Project bundle exceeds the scratch budget. Remove old exports or increase the configured budget.',
          );
        await checkSpace(chunk.length);
        signal.throwIfAborted();
        bytes += chunk.length;
        hash.update(chunk);
        options.progress(bytes);
      })().then(
        () => callback(null, chunk),
        (error: Error) => callback(error),
      );
    },
  });
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error('Archive writing failed.');
    controller.abort(failure);
    input?.destroy(failure);
    output.destroy(failure);
  };
  zip.on('error', fail);
  const written = pipeline(
    output,
    guard,
    createWriteStream(options.archive, {
      flags: 'wx',
      mode: 0o600,
      highWaterMark: 16 * 1024,
    }),
    {
      signal,
    },
  );
  // Observe immediately: output may fail while the collector is awaiting a source read.
  // Abort that read as well, and always drain the writer before unlinking partial data.
  void written.catch(fail);
  return {
    signal,
    get error() {
      return failure;
    },
    async writeFile(name: string, contents: string) {
      signal.throwIfAborted();
      const chunks = [Buffer.from(contents)];
      input = Readable.from(chunks, { objectMode: false, signal });
      input.on('error', fail);
      const consumed = finished(input, { cleanup: true });
      void consumed.catch(() => {});
      try {
        zip.addReadStream(input, name, { size: Buffer.byteLength(contents), mode: 0o100600 });
        await Promise.race([consumed, written]);
        if (failure) throw failure;
        signal.throwIfAborted();
      } catch (error) {
        throw failure ?? error;
      } finally {
        // yazl retains entry/stream metadata until the central directory is emitted.
        // Its consumed iterator must not retain every file's original byte buffer.
        chunks.length = 0;
        input = undefined;
      }
    },
    async finish() {
      signal.throwIfAborted();
      zip.end();
      await written;
      return { bytes, sha256: hash.digest('hex') };
    },
    async checkCapacity() {
      signal.throwIfAborted();
      await checkSpace(0, true);
      signal.throwIfAborted();
    },
    async abort(error: unknown) {
      fail(error);
      await written.catch(() => {});
    },
  };
}
