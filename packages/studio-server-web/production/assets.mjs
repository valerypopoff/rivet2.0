import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import mime from 'mime';

export const assetPrefix = '/__rivet_web/';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export const validName = name => typeof name === 'string' && name.length <= 240 &&
  /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) && !name.split('/').some(p => !p || p === '.' || p === '..');
export const maxFileBytes = 64 * 1024 ** 2;
const maxManifestBytes = 1024 ** 2;
export const contentType = name => {
  const type = mime.getType(name) ?? 'application/octet-stream';
  return type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type;
};

/** One immutable manifest describes the complete import/worker/CSS graph. No
 * release pointer, browser lease, bucket listing or deletion is needed. */
export async function describeBuild(root) {
  const files = [];
  let bytes = 0;
  const visit = async (relative = '') => {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!validName(name) || entry.isSymbolicLink()) throw Error('Unsafe frontend build path');
      if (entry.isDirectory()) await visit(name);
      else {
        const info = await lstat(path.join(root, name));
        if (!info.isFile() || info.size > maxFileBytes) throw Error('Frontend file exceeds its bound');
        bytes += info.size;
        if (files.length >= 4096 || bytes > 512 * 1024 ** 2) throw Error('Frontend build exceeds its bound');
        files.push({ name, sha256: hash(await readFile(path.join(root, name))), bytes: info.size });
      }
    }
  };
  await visit();
  if (!files.some(f => f.name === 'index.html') || !files.some(f => f.name.endsWith('.js'))) throw Error('Incomplete frontend build');
  const body = Buffer.from(JSON.stringify({ version: 1, files }));
  if (body.length > maxManifestBytes) throw Error('Frontend manifest exceeds its bound');
  return { id: hash(body), body, files };
}

export function parseManifest(id, body) {
  if (body.length > maxManifestBytes || hash(body) !== id) throw Error('Frontend manifest identity changed');
  const value = JSON.parse(body.toString());
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length > 4096 ||
      value.files.some(f => !validName(f.name) || !validId(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > maxFileBytes) ||
      new Set(value.files.map(f => f.name)).size !== value.files.length ||
      !value.files.some(f => f.name === 'index.html')) throw Error('Invalid frontend manifest');
  return value;
}

export function pageForBuild(bytes, id) {
  const html = bytes.toString('utf8');
  if (/<base\b/i.test(html) || !/<head(?:\s[^>]*)?>/i.test(html)) throw Error('Invalid frontend HTML base');
  return html.replace(/<head(?:\s[^>]*)?>/i, head =>
    `${head}<base href="${assetPrefix}${id}/"><meta name="rivet-web-build" content="${id}">`);
}

export class BuildAssets {
  constructor(root, store) { this.root = root; this.store = store; this.manifests = new Map(); }
  async initialize() {
    this.current = await describeBuild(this.root);
    pageForBuild(await readFile(path.join(this.root, 'index.html')), this.current.id);
    if (this.store) {
      // Publish the manifest last. Readiness never advertises a partial graph.
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < this.current.files.length) {
          const file = this.current.files[next++];
          const data = await readFile(path.join(this.root, file.name));
          if (hash(data) !== file.sha256) throw Error('Frontend build changed during publication');
          await this.store.put(file.sha256, gzipSync(data), data.length);
        }
      }));
      await this.store.put(this.current.id, gzipSync(this.current.body), this.current.body.length);
    }
    this.manifests.set(this.current.id, this.current);
  }
  async manifest(id) {
    if (!validId(id)) return undefined;
    if (this.manifests.has(id)) return this.manifests.get(id);
    if (!this.store) return undefined;
    const result = await this.store.get(id, { maxBytes: maxManifestBytes });
    if (!result) return undefined;
    const body = gunzipSync(await result.bytes(), { maxOutputLength: maxManifestBytes });
    const value = parseManifest(id, body);
    if (this.manifests.size >= 16) this.manifests.delete([...this.manifests.keys()].find(key => key !== this.current.id));
    this.manifests.set(id, value);
    return value;
  }
  async file(id, name) {
    const manifest = await this.manifest(id);
    const file = manifest?.files.find(f => f.name === name);
    if (!file) return undefined;
    if (id === this.current.id) {
      return { file, local: path.join(this.root, name) };
    }
    const stored = await this.store.get(file.sha256, file.bytes);
    if (!stored) throw Error('Retained frontend file is unavailable');
    return { file, stored };
  }
}
