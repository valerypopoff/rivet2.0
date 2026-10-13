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

/** Immutable snapshots with supervisor-owned publication and live-tab retention. */
export class GenerationStore {
  constructor(root, { maxBytes = 2 * 1024 ** 3, maxGenerations = 128, graceMs = 5 * 60_000, now = Date.now } = {}) {
    this.root = path.resolve(root);
    this.maxBytes = maxBytes;
    this.maxGenerations = maxGenerations;
    this.graceMs = graceMs;
    this.now = now;
    this.pins = new Map();
    this.released = new Map();
    this.retiring = new Set();
    this.legacyPins = 0;
    this.legacyUntil = -Infinity;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const directory of [this.root, path.join(this.root, 'objects'), path.join(this.root, 'generations')]) {
      await mkdir(directory, { recursive: true });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Tunnel bundle cache directories must not be symbolic links.');
    }
    for (const name of await readdir(this.root)) {
      if (/^pending-(?:object-)?[a-f0-9-]{36}$/.test(name)) {
        // Only UUID-owned staging paths directly inside the dedicated cache.
        await rm(path.join(this.root, name), { recursive: true, force: true });
      }
    }
    await this.collectObjects();
    // Retain the most recent previous build until a replacement is published.
    // It is a recovery fallback, not permission to serve another checkout's HTML.
    const generations = await this.generations();
    this.known = new Set(generations.map(({ id }) => id));
    this.previous = generations.at(-1)?.id;
    this.latest = null;
  }

  async generations() {
    const generations = [];
    for (const id of await readdir(path.join(this.root, 'generations'))) {
      const info = await lstat(path.join(this.root, 'generations', id));
      if (!validGeneration(id) || !info.isDirectory() || info.isSymbolicLink())
        throw new Error('Tunnel bundle cache contains an unexpected generation entry.');
      const page = await readFile(path.join(this.directory(id), 'page.html'), 'utf8');
      if (!page.includes(`<meta name="rivet-dev-generation" content="${id}">`))
        throw new Error('Tunnel bundle cache generation ownership is invalid.');
      generations.push({ id, time: info.mtimeMs });
    }
    return generations.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }

  async collectObjects(keep = new Set()) {
    this.bytes = 0;
    for (const name of await readdir(path.join(this.root, 'objects'))) {
      const file = path.join(this.root, 'objects', name);
      const info = await lstat(file);
      if (!/^[a-f0-9]{64}$/.test(name) || !info.isFile() || info.isSymbolicLink())
        throw new Error('Tunnel bundle cache contains an unexpected object entry.');
      // Failed publication can have added objects before exhausting its budget.
      // After owned staging is removed, only objects with another hardlink are
      // referenced by a retained generation. Never prune a live generation.
      if (info.nlink === 1 && !keep.has(name)) {
        await rm(file);
      } else this.bytes += info.size;
    }
  }

  retain(id) {
    if (!validGeneration(id) || !this.known?.has(id) || this.retiring.has(id))
      throw new Error('Invalid frontend generation.');
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.pins.get(id) - 1;
      if (count) this.pins.set(id, count);
      else {
        this.pins.delete(id);
        this.released.set(id, this.now());
      }
    };
  }

  // Older frontends do not identify their generation on SSE. Fail safe until
  // those tabs close or reload, rather than guessing which assets they need.
  retainLegacy() {
    this.legacyPins++;
    let released = false;
    return () => {
      if (!released) {
        this.legacyPins--;
        this.legacyUntil = this.now() + this.graceMs;
      }
      released = true;
    };
  }

  async publish(output, { isCurrent = () => true } = {}) {
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    const names = await filesIn(output);
    if (!names.some((name) => name.endsWith('.js')) || !html.includes('</head>'))
      throw new Error('Incomplete frontend build.');
    // Check HTML's local bundle references before publication.
    for (const match of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)(?:[?#][^"]*)?"/g)) {
      await stat(path.join(output, match[1]));
    }
    // Validate the entire candidate before evicting anything. Hash once and
    // reserve exactly its new unique objects, not the full bundle's size.
    const files = [];
    const sizes = new Map();
    let additionalBytes = 0;
    for (const name of names) {
      const source = path.join(output, name);
      const hash = await hashFile(source);
      files.push({ name, source, hash });
      if (sizes.has(hash)) continue;
      const size = (await stat(source)).size;
      sizes.set(hash, size);
      try {
        if ((await hashFile(path.join(this.root, 'objects', hash))) !== hash)
          throw new Error('Tunnel bundle cache object is corrupt. Stop the stack and clear its tunnel cache volume.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        additionalBytes += size;
      }
    }
    if (!isCurrent()) throw new Error('Frontend publication was superseded.');
    if ([...sizes.values()].reduce((sum, size) => sum + size, 0) > this.maxBytes)
      throw new Error('Tunnel bundle cache build exceeds its disk budget. The last working build is retained.');
    await this.collectObjects(new Set(sizes.keys()));
    const generations = await this.generations();
    this.pruned = 0;
    for (const { id } of generations) {
      if (this.bytes + additionalBytes <= this.maxBytes && generations.length - this.pruned < this.maxGenerations)
        break;
      if (
        this.legacyPins ||
        this.now() < this.legacyUntil ||
        id === (this.latest ?? this.previous) ||
        this.pins.has(id) ||
        this.now() - (this.released.get(id) ?? -Infinity) < this.graceMs
      )
        continue;
      // Retire synchronously before the first filesystem await. A new HTTP
      // reader cannot acquire a pin halfway through deletion.
      this.retiring.add(id);
      try {
        await rm(this.directory(id), { recursive: true });
        this.known.delete(id);
        this.released.delete(id);
        this.pruned++;
      } finally {
        this.retiring.delete(id);
      }
      await this.collectObjects(new Set(sizes.keys()));
    }
    for (const [id, time] of this.released) if (this.now() - time >= this.graceMs) this.released.delete(id);
    if (this.bytes + additionalBytes > this.maxBytes || generations.length - this.pruned >= this.maxGenerations)
      throw Object.assign(
        new Error(
          'Tunnel bundle cache has no room for this build. Close unused tunnel tabs; retrying after five minutes. The last working build is retained.',
        ),
        { code: 'RIVET_DEV_CACHE_BUSY' },
      );
    const id = randomUUID();
    const staging = path.join(this.root, `pending-${id}`);
    await mkdir(staging);
    try {
      for (const { name, source, hash } of files) {
        const object = path.join(this.root, 'objects', hash);
        try {
          await stat(object);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const size = (await stat(source)).size;
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
      if (!isCurrent()) throw new Error('Frontend publication was superseded.');
      await rename(staging, path.join(this.root, 'generations', id));
      this.known.add(id);
      this.latest = id;
      return id;
    } finally {
      // This UUID-owned staging directory is always inside our cache root.
      await rm(staging, { recursive: true, force: true });
      await this.collectObjects();
    }
  }

  directory(id) {
    if (!validGeneration(id)) throw new Error('Invalid frontend generation.');
    return path.join(this.root, 'generations', id);
  }
}
