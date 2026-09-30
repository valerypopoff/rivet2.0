import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

test(
  'full candidate conversion verifies 192 MiB of expanded recordings with a 192 MiB heap',
  { timeout: 180_000 },
  async (context) => {
    const worker = fileURLToPath(new URL('./helpers/local-upgrade-bounded-copy.ts', import.meta.url));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bounded-worker-'));
    try {
      const bundledWorker = path.join(root, 'worker.mjs');
      // Compile before starting the measured process. Yarn PnP + tsx retain
      // compiler/ZIP caches and loader threads that are not serving-runtime
      // memory and can consume most of this ceiling before conversion starts.
      await build({
        entryPoints: [worker],
        outfile: bundledWorker,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      });
      const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=192', bundledWorker], {
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 170_000,
        maxBuffer: 1048576,
        windowsHide: true,
      });
      const report = JSON.parse(stdout.trim());
      assert.deepEqual(report.execArgv, ['--max-old-space-size=192']);
      assert.equal(report.nodeOptionsConfigured, false);
      assert.equal(report.heapLimitMiB, 192);
      assert.equal(report.recordings, 192);
      assert.ok(report.decodedRecordingBytes > 192 * 1048576);
      assert.ok(report.peakRssKiB < 512 * 1024);
      context.diagnostic(
        `Converted ${report.recordings} recordings; peak RSS ${report.peakRssKiB} KiB (512 MiB ceiling).`,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
