import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { BuildAssets, assetPrefix, validId, validName, pageForBuild, contentType } from './assets.mjs';
import { createAssetStore } from './s3.mjs';

export async function productionServer({ root, store, logger = console } = {}) {
  const assets = new BuildAssets(root, store);
  await assets.initialize();
  let active = 0;
  const server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (active >= 32) { res.writeHead(503).end(); return; }
    active++;
    try {
      const url = new URL(req.url, 'http://localhost');
      let id = assets.current.id, name;
      if (url.pathname.startsWith(assetPrefix)) {
        const [build, ...parts] = url.pathname.slice(assetPrefix.length).split('/');
        name = parts.join('/'); id = build;
        if (!validId(id) || !validName(name)) { res.writeHead(404).end(); return; }
      } else {
        const pin = url.searchParams.get('webBuild');
        if (pin !== null) {
          if (!validId(pin)) { res.writeHead(400).end(); return; }
          id = pin;
        }
        // Preserve the existing SPA's direct/editor opening behavior. Only
        // immutable version URLs return 404 rather than falling back to HTML.
        name = url.pathname.slice(1);
        if (!assets.current.files.some(f => f.name === name)) name = 'index.html';
      }
      const result = await assets.file(id, name);
      if (!result) { res.writeHead(404).end(); return; }
      const { file, local, stored } = result;
      if (res.destroyed) { stored?.stream.destroy(); return; }
      res.setHeader('X-Rivet-Web-Build', id);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', contentType(name));
      if (name === 'index.html') {
        // HTML is always revalidated; an explicit pin is used only by an
        // existing dashboard's iframe, never as a mutable "latest" pointer.
        res.setHeader('Cache-Control', 'no-store');
        const body = local ? await readFile(local) : gunzipSync(await stored.bytes(), { maxOutputLength: file.bytes });
        const html = pageForBuild(body, id);
        res.setHeader('Content-Length', Buffer.byteLength(html));
        res.end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      res.setHeader('Cache-Control', url.pathname.startsWith(assetPrefix) ? 'public, max-age=31536000, immutable' : 'no-cache');
      res.setHeader('ETag', `"${file.sha256}"`);
      if (req.headers['if-none-match'] === `"${file.sha256}"`) { stored?.stream.destroy(); res.writeHead(304).end(); return; }
      const compressed = stored && /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers['accept-encoding'] ?? '');
      res.setHeader('Vary', 'Accept-Encoding');
      if (compressed) { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Content-Length', stored.length); }
      else res.setHeader('Content-Length', file.bytes);
      if (req.method === 'HEAD') { stored?.stream.destroy(); res.end(); return; }
      const source = local ? createReadStream(local) : stored.stream;
      res.once('close', () => source.destroy());
      if (stored && !compressed) await pipeline(source, createGunzip(), res);
      else await pipeline(source, res);
    } catch (error) {
      logger.error('Frontend asset request failed:', error.message);
      if (res.headersSent) res.destroy(); else res.writeHead(503, { 'Cache-Control': 'no-store' }).end('Frontend build unavailable');
    } finally { active--; }
  });
  server.on('close', () => store?.dispose());
  return { server, assets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.RIVET_WEB_ASSETS_DOTENV_FILE) process.loadEnvFile(process.env.RIVET_WEB_ASSETS_DOTENV_FILE);
  const { server } = await productionServer({ root: process.env.RIVET_WEB_DIST ?? '/app/dist', store: createAssetStore() });
  server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
