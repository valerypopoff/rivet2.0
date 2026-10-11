import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenerationStore } from '../dev/generations.mjs';
import { createTunnelServer } from '../dev/server.mjs';

test('cache pressure preserves an open browser generation, lazy imports and workers', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rivet-browser-cache-'));
  const output = path.join(root, 'output');
  await mkdir(output);
  await writeFile(
    path.join(output, 'index.html'),
    '<html><head><script type="module" src="./entry.js"></script></head><body>Fixture</body></html>',
  );
  await writeFile(
    path.join(output, 'entry.js'),
    `
    const generation = document.querySelector('meta[name="rivet-dev-generation"]').content;
    window.events = new EventSource('/__rivet_dev/events?generation=' + generation);
    window.loadLazy = () => import('./lazy.js').then(module => module.value);
    window.loadWorker = () => new Promise(resolve => {
      const worker = new Worker(new URL('./worker.js', import.meta.url));
      worker.onmessage = event => { worker.terminate(); resolve(event.data); };
    });
  `,
  );
  await writeFile(path.join(output, 'lazy.js'), 'export const value = "original";');
  await writeFile(path.join(output, 'worker.js'), 'postMessage("original worker");');
  const store = new GenerationStore(path.join(root, 'cache'), { maxGenerations: 2, graceMs: 0 });
  await store.initialize();
  const first = await store.publish(output);
  const api = createTunnelServer(store, { session: 'fixture', phase: 'ready', generation: first });
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  const address = api.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(base);
    await expect.poll(() => store.pins.get(first) ?? 0).toBe(1);
    await writeFile(path.join(output, 'lazy.js'), 'export const value = "replacement";');
    const second = await store.publish(output);
    await expect(store.publish(output)).rejects.toThrow('no room');
    expect(await page.evaluate(() => (window as any).loadLazy())).toBe('original');
    expect(await page.evaluate(() => (window as any).loadWorker())).toBe('original worker');
    await page.close();
    await expect.poll(() => store.pins.get(first) ?? 0).toBe(0);
    const third = await store.publish(output);
    expect(third).not.toBe(second);
    expect((await fetch(`${base}/?devBuild=${first}`)).status).toBe(404);
    expect((await fetch(`${base}/?devBuild=${second}`)).status).toBe(200);
  } finally {
    api.closeClients();
    api.server.closeAllConnections();
    await new Promise<void>((resolve) => api.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
