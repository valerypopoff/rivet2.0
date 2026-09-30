import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { inspectLocalCopyCapacity } from '../local-metadata/copy-capacity.js';

async function fixture(
  run: (
    source: { workflows: string; recordings: string; appData: string; runtimeLibraries: string },
    root: string,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-capacity-'));
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'libraries'),
  };
  const previous = process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB;
  process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB = '16';
  try {
    for (const directory of Object.values(source)) await fs.mkdir(directory);
    await run(source, root);
  } finally {
    if (previous === undefined) delete process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB;
    else process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('capacity counts expanded legacy gzip instead of trusting declared recording sizes', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.recordings, 'recording.gz'), gzipSync(Buffer.alloc(17 * 1024 * 1024)));
    await fs.writeFile(
      path.join(source.recordings, 'metadata.json'),
      JSON.stringify({ version: 1, recordingUncompressedBytes: 1 }),
    );
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.fits, false);
    assert.equal(capacity.measurementComplete, false);
    assert.ok(capacity.reasons.includes('payload-budget'));
  });
});

test('capacity permits an aggregate larger than the bundle budget without scaling its memory estimate', async () => {
  await fixture(async (source, root) => {
    for (let index = 0; index < 20; index++) {
      const bundle = path.join(source.recordings, String(index));
      await fs.mkdir(bundle);
      await fs.writeFile(path.join(bundle, 'recording.gz'), gzipSync(Buffer.alloc(1024 * 1024)));
    }
    const capacity = await inspectLocalCopyCapacity(source, root, {
      availableMemoryBytes: 1024 * 1024 * 1024,
      heapLimitBytes: 1024 * 1024 * 1024,
      freeDiskBytes: 1024 * 1024 * 1024,
    });
    assert.ok(capacity.payloadBytes > capacity.maxPayloadBytes);
    assert.equal(capacity.measurementComplete, true);
    assert.equal(capacity.fits, true);
    assert.equal(capacity.estimatedWorkingBytes, 8 * 16 * 1048576 + 64 * 1048576);
  });
});

test('capacity stops before gzip decoding once on-disk bytes already exceed the budget', async () => {
  await fixture(async (source, root) => {
    // Deliberately invalid gzip must never be decoded after capacity refusal.
    await fs.writeFile(path.join(source.recordings, 'oversized.gz'), Buffer.alloc(17 * 1024 * 1024));
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.fits, false);
    assert.equal(capacity.measurementComplete, false);
    assert.ok(capacity.reasons.includes('payload-budget'));
  });
});

test('capacity refuses disk and memory exhaustion independently, even inside the payload budget', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.workflows, 'small'), Buffer.alloc(1024));
    const memory = await inspectLocalCopyCapacity(source, root, {
      availableMemoryBytes: 1,
      heapLimitBytes: 1024 * 1024 * 1024,
    });
    assert.deepEqual(memory.reasons, ['memory-headroom']);
    const disk = await inspectLocalCopyCapacity(source, root, {
      availableMemoryBytes: 1024 * 1024 * 1024,
      heapLimitBytes: 1024 * 1024 * 1024,
      freeDiskBytes: 1,
    });
    assert.deepEqual(disk.reasons, ['disk-space']);
    assert.equal(disk.fits, false);
  });
});

test('capacity includes committed WAL and recovery-journal storage without opening databases', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.appData, 'evaluation-runs.sqlite'), Buffer.alloc(100));
    await fs.writeFile(path.join(source.appData, 'evaluation-runs.sqlite-wal'), Buffer.alloc(200));
    await fs.writeFile(path.join(source.appData, 'llm-profile-health.sqlite-journal'), Buffer.alloc(300));
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.operationalBytes, 600);
    assert.equal(capacity.requiredBytes, 1200 + 32 * 1024 * 1024);
    assert.equal(capacity.fits, true);
  });
});
