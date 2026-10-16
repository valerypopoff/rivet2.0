import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { S3Assets } from '../production/s3.mjs';
import { productionServer } from '../production/server.mjs';

test('an open dirty tab loads old lazy modules, CSS, workers and pinned iframe after all old replicas stop', async ({ page }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rivet-production-browser-'));
  const objects = new Map<string, any>();
  const store = new S3Assets({
    async send(command: any) {
      const input = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(input.Key, { body: Buffer.from(input.Body), metadata: input.Metadata }); return {};
      }
      const value = objects.get(input.Key);
      if (!value) throw Object.assign(Error('Missing'), { $metadata: { httpStatusCode: 404 } });
      return { Metadata: value.metadata, ContentLength: value.body.length,
        ...(command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([value.body]) } : {}) };
    }, destroy() {},
  }, { bucket: 'fixture', prefix: 'frontend/' });
  const servers: ReturnType<typeof createServer>[] = [];
  async function build(version: string) {
    const root = path.join(directory, version); await mkdir(root);
    await writeFile(path.join(root, 'index.html'), '<html><head><script type="module" src="./entry.js"></script></head><body><textarea aria-label="Unsaved work"></textarea><button id="lazy">Open lazy screen</button><div id="screen"></div></body></html>');
    await writeFile(path.join(root, 'entry.js'), `
      window.boots = (window.boots || 0) + 1;
      window.build = document.querySelector('meta[name="rivet-web-build"]').content;
      document.querySelector('#lazy').onclick = async () => {
        const module = await import('./lazy.js');
        document.querySelector('#screen').textContent = module.default;
        const css = document.createElement('link'); css.rel='stylesheet'; css.href=new URL('./lazy.css', import.meta.url); document.head.append(css);
        const worker = new Worker(new URL('./worker.js', import.meta.url));
        worker.onmessage = event => { window.workerResult=event.data; worker.terminate(); };
        const frame = document.createElement('iframe'); frame.src='/?editor&webBuild='+window.build; document.body.append(frame);
      };
    `);
    await writeFile(path.join(root, 'lazy.js'), `export default ${JSON.stringify(version)};`);
    await writeFile(path.join(root, 'lazy.css'), '#screen { color: rgb(1, 2, 3); }');
    await writeFile(path.join(root, 'worker.js'), `postMessage(${JSON.stringify(version)});`);
    const value = await productionServer({ root, store });
    servers.push(value.server);
    await new Promise<void>(resolve => value.server.listen(0, '127.0.0.1', resolve));
    return value;
  }
  let current: ReturnType<typeof createServer>;
  const edge = createServer((req, res) => {
    const upstream = request({ host: '127.0.0.1', port: (current.address() as any).port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  servers.push(edge);
  try {
    const old = await build('original'); current = old.server;
    await new Promise<void>(resolve => edge.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(edge.address() as any).port}`;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await expect(page.getByLabel('Unsaved work')).toBeVisible();
    await page.getByLabel('Unsaved work').fill('Do not lose this edit');
    const replacement = await build('replacement'); current = replacement.server;
    old.server.closeAllConnections(); await new Promise<void>(resolve => old.server.close(() => resolve()));
    await page.locator('#lazy').click();
    await expect(page.locator('#screen')).toHaveText('original');
    await expect(page.locator('#screen')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect.poll(() => page.evaluate(() => (window as any).workerResult)).toBe('original');
    await expect(page.getByLabel('Unsaved work')).toHaveValue('Do not lose this edit');
    expect(await page.evaluate(() => (window as any).boots)).toBe(1);
    await expect.poll(() => page.frames().length).toBe(2);
    await expect.poll(() => page.frames()[1].locator('meta[name="rivet-web-build"]').getAttribute('content')).toBe(old.assets.current.id);
    const fresh = await page.context().newPage(); await fresh.goto(base);
    expect(await fresh.locator('meta[name="rivet-web-build"]').getAttribute('content')).toBe(replacement.assets.current.id);
    expect(errors).toEqual([]);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await rm(directory, { recursive: true, force: true });
  }
});
