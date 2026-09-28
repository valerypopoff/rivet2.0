import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test(
  'full candidate conversion verifies 192 MiB of expanded recordings with a 192 MiB heap',
  { timeout: 180_000 },
  async () => {
    const worker = fileURLToPath(new URL('./helpers/local-upgrade-bounded-copy.ts', import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--max-old-space-size=192', '--import', 'tsx', worker],
      { timeout: 170_000, maxBuffer: 1048576, windowsHide: true },
    );
    const report = JSON.parse(stdout.trim());
    assert.equal(report.recordings, 192);
    assert.ok(report.decodedRecordingBytes > 128 * 1048576);
    assert.ok(report.peakRssKiB < 512 * 1024);
  },
);
