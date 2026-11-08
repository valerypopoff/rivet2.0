import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Scope normalization to installed dependencies. Application timestamps and
// build/source provenance have different meanings and must remain untouched.
async function inspectRuntimeDependencies(root, normalize) {
  assert.ok((await fs.lstat(root)).isDirectory(), 'Dependency root must be a real directory');
  if (normalize) {
    // COPY's cache key ignores mtimes. Bind metadata policy to actual content so
    // a warm cache cannot retain a layer made before a normalization repair.
    const marker = path.join(root, '.rivet-runtime-layout.json');
    const prior = await fs.lstat(marker).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert.ok(!prior || prior.isFile(), 'Dependency layout marker must be a regular file');
    const file = await fs.open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    try {
      await file.writeFile(
        JSON.stringify({
          protocol: 1,
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          policy: createHash('sha256')
            .update(await fs.readFile(new URL(import.meta.url)))
            .digest('hex'),
        }) + '\n',
      );
    } finally {
      await file.close();
    }
  }
  const hash = createHash('sha256');
  const counts = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  const queue = [{ file: root, relative: '.' }],
    records = [];
  const visit = async ({ file, relative }) => {
    const stat = await fs.lstat(file);
    const entry = { path: relative.replaceAll(path.sep, '/'), mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
    if (stat.isSymbolicLink()) {
      entry.link = await fs.readlink(file);
      counts.symlinks++;
      if (normalize) await fs.lutimes(file, 0, 0); // Never touch a workspace/external link target.
    } else if (stat.isDirectory()) {
      entry.directory = true;
      counts.directories++;
      const names = (await fs.readdir(file)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const name of names) queue.push({ file: path.join(file, name), relative: path.join(relative, name) });
      if (normalize) await fs.utimes(file, 0, 0);
    } else {
      assert.ok(stat.isFile(), 'Unsupported dependency filesystem entry');
      const content = createHash('sha256');
      for await (const chunk of createReadStream(file)) content.update(chunk);
      entry.sha256 = content.digest('hex');
      entry.bytes = stat.size;
      counts.files++;
      counts.bytes += stat.size;
      if (normalize) await fs.utimes(file, 0, 0);
    }
    records.push(entry);
  };
  // Bound filesystem work rather than opening every dependency at once. Hash
  // records in path order so concurrency cannot change the exported fingerprint.
  for (let next = 0; next < queue.length; ) {
    const batch = queue.slice(next, next + 16);
    next += batch.length;
    const results = await Promise.allSettled(batch.map(visit));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const entry of records) hash.update(JSON.stringify(entry) + '\n');
  return { protocol: 1, sha256: hash.digest('hex'), ...counts };
}

export const normalizeRuntimeDependencies = (root) => inspectRuntimeDependencies(root, true);
export const fingerprintRuntimeDependencies = (root) => inspectRuntimeDependencies(root, false);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length > 2, 'Specify installed dependency directories');
  for (const root of process.argv.slice(2)) {
    const result = await normalizeRuntimeDependencies(root);
    console.log(JSON.stringify({ root, ...result }));
  }
}
