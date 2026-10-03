import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream';
import { bundlePrefix, validGeneration } from './generations.mjs';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function createTunnelServer(store, state) {
  const clients = new Set();
  const publish = () => {
    const event = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 64 * 1024) client.destroy();
      else client.write(event);
    }
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405).end();
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (url.pathname === '/__rivet_dev/events') {
        if (req.method === 'HEAD') {
          res.writeHead(405).end();
          return;
        }
        if (clients.size >= 64) {
          res.writeHead(503).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        clients.add(res);
        res.write(`data: ${JSON.stringify(state)}\n\n`);
        const timer = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
        res.on('close', () => {
          clearInterval(timer);
          clients.delete(res);
        });
        return;
      }
      if (url.pathname === '/__rivet_dev/status') {
        res
          .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(state));
        return;
      }
      if (url.pathname === '/readyz') {
        res.writeHead(store.latest ? 200 : 503).end(store.latest ? 'ready' : 'building');
        return;
      }
      if (url.pathname === '/') {
        const id = url.searchParams.get('devBuild') ?? store.latest;
        if (!id) {
          res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' }).end('Frontend is building.');
          return;
        }
        const html = await readFile(path.join(store.directory(id), 'page.html'));
        res
          .writeHead(200, { 'Content-Type': types['.html'], 'Cache-Control': 'no-store' })
          .end(req.method === 'HEAD' ? undefined : html);
        return;
      }
      if (!url.pathname.startsWith(bundlePrefix)) {
        res.writeHead(404).end();
        return;
      }
      const [id, ...parts] = decodeURIComponent(url.pathname.slice(bundlePrefix.length)).split('/');
      if (!validGeneration(id) || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
        res.writeHead(404).end();
        return;
      }
      const directory = store.directory(id);
      const file = path.resolve(directory, ...parts);
      if (!file.startsWith(directory + path.sep)) {
        res.writeHead(404).end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      const acceptsGzip = (req.headers['accept-encoding'] ?? '').split(',').some((value) => {
        const [encoding, ...parameters] = value.trim().split(';');
        const quality = parameters.find((parameter) => /^\s*q\s*=/i.test(parameter));
        const weight = quality ? Number(quality.split('=')[1]) : 1;
        return encoding.trim().toLowerCase() === 'gzip' && Number.isFinite(weight) && weight > 0 && weight <= 1;
      });
      const compressed = acceptsGzip && /\.(js|css|json|svg|map)$/.test(file);
      res.writeHead(200, {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : { 'Content-Length': info.size }),
        Vary: 'Accept-Encoding',
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') res.end();
      else {
        // pipeline retires the file AND compression stream on disconnect/error;
        // destroying only the file can leave an abandoned transform buffered.
        const streams = compressed ? [createReadStream(file), createGzip(), res] : [createReadStream(file), res];
        pipeline(streams, () => {});
      }
    } catch (error) {
      if (!res.headersSent)
        res
          .writeHead(
            error instanceof URIError || error.code === 'ENOENT' || error.message === 'Invalid frontend generation.'
              ? 404
              : 500,
          )
          .end();
      else res.destroy();
    }
  });
  const closeClients = () => {
    for (const client of clients) client.end();
  };
  return { server, publish, closeClients };
}
