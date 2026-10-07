import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const bundlePrefix = '/__rivet_dev/bundles/';
export const validGeneration = (id) =>
  typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

async function filesIn(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build output must not contain symbolic links.');
    if (entry.isDirectory()) files.push(...(await filesIn(root, name)));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Immutable snapshots: never remove an older generation while a tab may use it. */
export class GenerationStore {
  constructor(root, { maxBytes = 2 * 1024 ** 3, maxGenerations = 128 } = {}) {
    this.root = path.resolve(root);
    this.maxBytes = maxBytes;
    this.maxGenerations = maxGenerations;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root)) {
      if (/^pending-(?:object-)?[a-f0-9-]{36}$/.test(name)) {
        // Only UUID-owned staging paths directly inside the dedicated cache.
        await rm(path.join(this.root, name), { recursive: true, force: true });
      }
    }
    await mkdir(path.join(this.root, 'objects'), { recursive: true });
    await mkdir(path.join(this.root, 'generations'), { recursive: true });
    this.bytes = 0;
    for (const name of await readdir(path.join(this.root, 'objects'))) {
      const file = path.join(this.root, 'objects', name);
      const info = await lstat(file);
      // Failed publication can have added objects before exhausting its budget.
      // After owned staging is removed, only objects with another hardlink are
      // referenced by a retained generation. Never prune a live generation.
      if (/^[a-f0-9]{64}$/.test(name) && info.isFile() && info.nlink === 1) {
        await rm(file);
      } else this.bytes += info.size;
    }
    // Do not reuse a prior checkout's HTML before its first successful build.
    this.latest = null;
  }

  async publish(output) {
    const generations = await readdir(path.join(this.root, 'generations'));
    if (generations.length >= this.maxGenerations)
      throw new Error('Tunnel bundle cache is full. Stop the stack and clear its tunnel cache volume.');
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    const names = await filesIn(output);
    if (!names.some((name) => name.endsWith('.js')) || !html.includes('</head>'))
      throw new Error('Incomplete frontend build.');
    // Check HTML's local bundle references before publication.
    for (const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
      await stat(path.join(output, match[1]));
    }
    const id = randomUUID();
    const staging = path.join(this.root, `pending-${id}`);
    await mkdir(staging);
    try {
      for (const name of names) {
        const source = path.join(output, name);
        const hash = await hashFile(source);
        const object = path.join(this.root, 'objects', hash);
        try {
          if ((await hashFile(object)) !== hash)
            throw new Error('Tunnel bundle cache object is corrupt. Stop the stack and clear its tunnel cache volume.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const size = (await stat(source)).size;
          if (this.bytes + size > this.maxBytes)
            throw new Error(
              'Tunnel bundle cache exceeds its disk budget. Stop the stack and clear its tunnel cache volume.',
            );
          const pendingObject = path.join(this.root, `pending-object-${randomUUID()}`);
          try {
            await copyFile(source, pendingObject);
            await rename(pendingObject, object);
          } finally {
            await rm(pendingObject, { force: true });
          }
          this.bytes += size;
        }
        const target = path.join(staging, name);
        await mkdir(path.dirname(target), { recursive: true });
        await link(object, target);
      }
      // Relative bundle imports and worker URLs resolve inside this generation.
      // Base must precede every script/preload: browsers start fetching while
      // parsing, before a base appended at the end of head would take effect.
      const page = html.replace(
        /<head(?:\s[^>]*)?>/i,
        (head) => `${head}<base href="${bundlePrefix}${id}/"><meta name="rivet-dev-generation" content="${id}">`,
      );
      // index.html was hardlinked: replace, never mutate a content-addressed object.
      await writeFile(path.join(staging, 'page.html'), page);
      await rename(staging, path.join(this.root, 'generations', id));
      this.latest = id;
      return id;
    } finally {
      // This UUID-owned staging directory is always inside our cache root.
      await rm(staging, { recursive: true, force: true });
    }
  }

  directory(id) {
    if (!validGeneration(id)) throw new Error('Invalid frontend generation.');
    return path.join(this.root, 'generations', id);
  }
}
