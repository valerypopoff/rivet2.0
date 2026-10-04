// Runs only inside verify-tunnel.integration.mjs's disposable Linux fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.env.RIVET_TUNNEL_OWNED_FIXTURE, '1', 'Refusing to modify a working checkout');
assert.equal(process.cwd(), '/workspace');
const base = 'http://127.0.0.1:5174';
const root = '/tunnel-cache';
const measurements = [];
let peak = 0;
let sampling = false;
async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    let rss = 0;
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        if (/^Name:\s+node$/m.test(status)) rss += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
      } catch {
        /* Exiting processes are expected. */
      }
    }
    peak = Math.max(peak, rss);
  } finally {
    sampling = false;
  }
}
const sampler = setInterval(() => void sample().catch(() => undefined), 300);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function status() {
  return (await fetch(`${base}/__rivet_dev/status`, { signal: AbortSignal.timeout(5_000) })).json();
}
async function waitFor(predicate, allowPreviousFailure = false) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    try {
      const state = await status();
      if (predicate(state)) return state;
      if (state.phase === 'building') allowPreviousFailure = false;
      if (state.phase === 'failed' && !allowPreviousFailure) throw new Error(state.error || 'Fixture build failed');
    } catch (error) {
      // The fixture can still be copying its source before HTTP starts listening.
      if (!(error instanceof TypeError)) throw error;
    }
    await sleep(500);
  }
  throw new Error('Fixture build did not settle before its deadline');
}
async function objectsSize() {
  let bytes = 0;
  for (const name of await readdir(path.join(root, 'objects')))
    bytes += (await stat(path.join(root, 'objects', name))).size;
  return bytes;
}
async function contains(generation, marker, suffix) {
  const directory = path.join(root, 'generations', generation, 'assets');
  for (const file of await readdir(directory)) {
    if (file.endsWith(suffix) && (await readFile(path.join(directory, file), 'utf8')).includes(marker)) return true;
  }
  return false;
}
async function measured(label, operation) {
  peak = 0;
  const start = label === 'cold-ready-wait' ? Number(process.env.RIVET_FIXTURE_LAUNCH_AT) : Date.now();
  const state = await operation();
  await sample();
  measurements.push({
    label,
    elapsedMs: Date.now() - start,
    compilerMs: state.durationMs,
    peakNodeRssKiB: peak,
    uniqueObjectBytes: await objectsSize(),
  });
  console.log(`[tunnel-integration] ${label}: ${JSON.stringify(measurements.at(-1))}`);
  return state;
}
try {
  let current = await measured('cold-ready-wait', () => waitFor((state) => state.phase === 'ready'));
  const initialGeneration = current.generation;
  const initialHtml = await (await fetch(base)).text();
  const file = '/workspace/packages/studio-server-web/dashboard/DashboardPage.tsx';
  const original = await readFile(file, 'utf8');
  for (const [label, target, text, marker, suffix] of [
    [
      'warm-css',
      '/workspace/packages/studio-server-web/dashboard/DashboardPage.css',
      '\n.tunnel-probe-css { color: #123456; }\n',
      'tunnel-probe-css',
      '.css',
    ],
    ['warm-tsx', file, '\nconsole.info("tunnel-probe-tsx");\n', 'tunnel-probe-tsx', '.js'],
    [
      'warm-core',
      '/workspace/packages/core/src/model/nodes/DelayNode.ts',
      '\nconsole.info("tunnel-probe-core");\n',
      'tunnel-probe-core',
      '.js',
    ],
  ]) {
    const previous = current.generation;
    current = await measured(label, async () => {
      await writeFile(target, (await readFile(target, 'utf8')) + text);
      return waitFor((state) => state.phase === 'ready' && state.generation !== previous);
    });
    assert.ok(await contains(current.generation, marker, suffix), `${label} did not reach published assets`);
  }
  const lastGood = current.generation;
  await writeFile(file, original + '\nexport const = ;\n');
  await waitFor((state) => state.phase === 'failed');
  assert.equal((await status()).generation, lastGood, 'Compile error replaced the working generation');
  assert.equal((await fetch(`${base}/?devBuild=${initialGeneration}`)).status, 200);
  assert.equal(await (await fetch(`${base}/?devBuild=${initialGeneration}`)).text(), initialHtml, 'Old HTML changed');
  current = await measured('repair', async () => {
    await writeFile(file, original);
    return waitFor((state) => state.phase === 'ready' && state.generation !== lastGood, true);
  });
  // API-only edits must not trigger the frontend watcher. This is not a claim
  // about the API/executor integration, which is verified separately.
  await writeFile('/workspace/packages/studio-server-api/src/tunnel-owned-probe.mjs', 'export const changed = true;\n');
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    assert.deepEqual(await status(), current, 'API-only edit caused a frontend build/refresh');
  }
  await writeFile(
    '/workspace/artifacts/tunnel-measurements.json',
    JSON.stringify({ passed: true, measurements, apiOnlyEditDidNotRebuild: true }, null, 2),
  );
} finally {
  clearInterval(sampler);
}
