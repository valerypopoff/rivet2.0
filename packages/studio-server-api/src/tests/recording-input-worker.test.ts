import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { WorkflowRecordingInputExtractor } from '../routes/workflows/recording-input-extractor.js';

const workerUrl = new URL(
  import.meta.url.endsWith('.ts')
    ? '../../dist/studio-server-api/src/routes/workflows/recording-input-extractor-worker.js'
    : '../routes/workflows/recording-input-extractor-worker.js',
  import.meta.url,
);
const source = {
  kind: 'artifact' as const,
  encoding: 'gzip' as const,
  bytes: gzipSync(
    JSON.stringify({
      recording: { events: [{ type: 'start', data: { inputs: { input: { value: '$STRING:request' } } } }] },
      assets: { unrelated: 'x'.repeat(1024 * 1024) },
      strings: { request: 'needle' },
    }),
  ),
};

test('catalog preparation creates only one idle worker and shares it with searches', async () => {
  const workers: Worker[] = [];
  const extractor = new WorkflowRecordingInputExtractor(() => {
    const worker = new Worker(workerUrl);
    workers.push(worker);
    return worker;
  });
  try {
    for (let i = 0; i < 20; i++) extractor.prepare();
    assert.equal(workers.length, 1);
    assert.deepEqual(await extractor.extract(source), { exists: true, value: 'needle' });
    assert.equal(workers.length, 1);
    await workers[0]!.terminate();
    assert.deepEqual(await extractor.extract(source), { exists: true, value: 'needle' });
    assert.equal(workers.length, 2);
  } finally {
    extractor.dispose();
  }
});

test('optional preparation failure does not throw or prevent a later search', async () => {
  let attempts = 0;
  const extractor = new WorkflowRecordingInputExtractor(() => {
    if (++attempts === 1) throw new Error('temporary startup failure');
    return new Worker(workerUrl);
  });
  try {
    assert.doesNotThrow(() => extractor.prepare());
    assert.deepEqual(await extractor.extract(source), { exists: true, value: 'needle' });
    assert.equal(attempts, 2);
  } finally {
    extractor.dispose();
  }
});

test('disposing a prepared worker does not restart it in the background', async () => {
  const workers: Worker[] = [];
  const extractor = new WorkflowRecordingInputExtractor(() => {
    const worker = new Worker(workerUrl);
    workers.push(worker);
    return worker;
  });
  extractor.prepare();
  const exit = new Promise<void>((resolve) => workers[0]!.once('exit', () => resolve()));
  extractor.dispose();
  await exit;
  assert.equal(workers.length, 1);
});

test('compiled input workers recover from an unexpected idle exit without inline parsing', async () => {
  const workers: Worker[] = [];
  const extractor = new WorkflowRecordingInputExtractor(() => {
    const worker = new Worker(workerUrl);
    workers.push(worker);
    return worker;
  });
  try {
    const expected = await extractor.extract(source);
    assert.equal(expected?.exists, true);
    await workers[0]!.terminate();
    assert.deepEqual(await extractor.extract(source), expected);
    assert.equal(workers.length, 2);
    assert.ok(source.bytes.byteLength > 0, 'caller-owned compressed buffer is not detached');
  } finally {
    extractor.dispose();
  }
});

test('compiled input worker rejects corrupt gzip and remains usable', async () => {
  const extractor = new WorkflowRecordingInputExtractor(() => new Worker(workerUrl));
  try {
    for (const bytes of [Buffer.from('not gzip'), gzipSync('{broken-json'), gzipSync('{}')]) {
      await assert.rejects(extractor.extract({ ...source, bytes }), /extraction failed|Malformed recording artifact/);
      assert.deepEqual(await extractor.extract(source), { exists: true, value: 'needle' });
      assert.deepEqual(
        await extractor.extract({ ...source, bytes: gzipSync(JSON.stringify({ recording: { events: [] } })) }),
        { exists: false, value: undefined },
      );
    }
    const controller = new AbortController();
    const cancelled = extractor.extract(source, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal((await extractor.extract(source))?.exists, true);
  } finally {
    extractor.dispose();
  }
});

test('compiled extraction never detaches or transfers unrelated provider bytes', async () => {
  const extractor = new WorkflowRecordingInputExtractor(() => new Worker(workerUrl));
  const backing = Buffer.concat([Buffer.from('prefix'), source.bytes, Buffer.from('suffix')]);
  const original = Buffer.from(backing);
  const shared = new Uint8Array(new SharedArrayBuffer(source.bytes.byteLength));
  shared.set(source.bytes);
  try {
    for (const bytes of [backing.subarray(6, 6 + source.bytes.byteLength), shared]) {
      assert.deepEqual(await extractor.extract({ ...source, bytes }), { exists: true, value: 'needle' });
      assert.deepEqual(Buffer.from(bytes), source.bytes);
    }
    assert.deepEqual(backing, original);
  } finally {
    extractor.dispose();
  }
});

test('worker startup failure has bounded retries and never runs queued extraction inline', async () => {
  let attempts = 0;
  const extractor = new WorkflowRecordingInputExtractor(() => {
    attempts++;
    throw new Error('unavailable');
  });
  try {
    await assert.rejects(extractor.extract(source), /workers unavailable/);
    assert.equal(attempts, 3);
    await assert.rejects(extractor.extract(source), /temporarily unavailable/);
    assert.equal(attempts, 3);
  } finally {
    extractor.dispose();
  }
});
