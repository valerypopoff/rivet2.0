import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  getManagedRecordingInputCacheKey,
  getRecordingInputCacheMaxBytes,
  WorkflowRecordingInputCache,
} from '../routes/workflows/recording-input-cache.js';
import { extractWorkflowRecordingInputFromSource } from '../routes/workflows/recording-input-source.js';
import { RECORDING_INPUT_PAGE_COMPLETE } from '../routes/workflows/recording-input-filter.js';

test('deployment cache memory budget is explicit, bounded, and defaults to 32 MiB', () => {
  assert.equal(getRecordingInputCacheMaxBytes({}), 32 * 1024 * 1024);
  assert.equal(getRecordingInputCacheMaxBytes({ RIVET_RECORDING_INPUT_CACHE_MAX_MIB: '64' }), 64 * 1024 * 1024);
  assert.equal(getRecordingInputCacheMaxBytes({ RIVET_RECORDING_INPUT_CACHE_MAX_MIB: '0' }), 0);
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', '513', '9007199254740992']) {
    assert.throws(() => getRecordingInputCacheMaxBytes({ RIVET_RECORDING_INPUT_CACHE_MAX_MIB: value }), /0 to 512/);
  }
});

test('cache diagnostics are isolated, payload-free, and distinguish capacity from expiry', async () => {
  let now = 0;
  const cache = new WorkflowRecordingInputCache({
    maxEntries: 1,
    ttlMs: 10,
    now: () => now,
    onCacheEvent: () => {
      throw new Error('broken diagnostics');
    },
  });
  const load = async () => createSerializedRecording('secret-value');
  await cache.getOrLoad('secret-key', load);
  await cache.getOrLoad('secret-key', load);
  await cache.getOrLoad('second', load);
  assert.equal(cache.diagnostics.hit, 1);
  assert.equal(cache.diagnostics.evicted, 1);
  assert.equal(cache.diagnostics.load, 2);
  assert.ok(cache.diagnostics.retainedBytes > 0);
  const snapshot = cache.diagnostics;
  snapshot.hit = 99;
  assert.equal(cache.diagnostics.hit, 1);
  now = 11;
  await cache.getOrLoad('second', load);
  assert.equal(cache.diagnostics.expired, 1);
  assert.equal(cache.diagnostics.load, 3);
  assert.doesNotMatch(JSON.stringify(cache.diagnostics), /secret/);
});

test('working sets larger than retention remain bounded and report rereads', async () => {
  const cache = new WorkflowRecordingInputCache({ maxBytes: 2048 });
  const load = async () => createSerializedRecording('x'.repeat(1024));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < 3; i++) await cache.getOrLoad(String(i), load);
  }
  assert.equal(cache.diagnostics.load, 6);
  assert.equal(cache.diagnostics.hit, 0);
  assert.ok(cache.diagnostics.retainedBytes <= 2048);
  assert.equal(cache.diagnostics.evicted, 5);
  const oversized = new WorkflowRecordingInputCache({ maxEntryBytes: 100 });
  await oversized.getOrLoad('large', load);
  assert.equal(oversized.diagnostics.oversized, 1);
  assert.equal(oversized.size, 0);
});

test('disabled completed retention still shares active loads and isolates consumers', async () => {
  const cache = new WorkflowRecordingInputCache({ maxBytes: 0 });
  let release!: (source: string) => void;
  let loads = 0;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const load = async () => {
    loads++;
    return pending;
  };
  const first = cache.getOrLoad('same', load);
  const second = cache.getOrLoad('same', load);
  release(createSerializedRecording('kept'));
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.notEqual(left, right);
  assert.equal(loads, 1);
  assert.equal(cache.diagnostics.shared, 1);
  assert.equal(cache.diagnostics.oversized, 0);
  assert.equal(cache.size, 0);
  await cache.getOrLoad('same', load);
  assert.equal(loads, 2);
});

test('normal page completion hands an admitted load to the next request without restarting it', async () => {
  const cache = new WorkflowRecordingInputCache();
  let release!: (value: string) => void;
  const source = new Promise<string>((resolve) => {
    release = resolve;
  });
  let loads = 0;
  const load = async () => {
    loads++;
    return source;
  };
  const controller = new AbortController();
  const first = cache.getOrLoad('handoff', load, controller.signal);
  await Promise.resolve();
  controller.abort(RECORDING_INPUT_PAGE_COMPLETE);
  await assert.rejects(first, { name: 'AbortError' });
  const second = cache.getOrLoad('handoff', load);
  release(createSerializedRecording('kept'));
  assert.deepEqual(await second, { exists: true, value: 'kept' });
  assert.equal(loads, 1);
});

test('memory-weighted admission runs large loads alone and preserves consumer isolation', async () => {
  const cache = new WorkflowRecordingInputCache({ maxEstimatedLoadBytes: 100 });
  let release!: (value: string) => void;
  const source = new Promise<string>((resolve) => {
    release = resolve;
  });
  const first = cache.getOrLoad('large', async () => source, undefined, 101);
  const shared = cache.getOrLoad('large', async () => {
    throw new Error('duplicate');
  });
  let secondStarted = false;
  const second = cache.getOrLoad(
    'small',
    async () => {
      secondStarted = true;
      return createSerializedRecording('small');
    },
    undefined,
    1,
  );
  await Promise.resolve();
  assert.equal(secondStarted, false);
  release(createSerializedRecording({ name: 'original' }));
  const [left, right] = await Promise.all([first, shared]);
  (left!.value as { name: string }).name = 'changed';
  assert.deepEqual(right!.value, { name: 'original' });
  await second;
  assert.equal(secondStarted, true);
});

function createSerializedRecording(input: unknown): string {
  return JSON.stringify({
    version: 1,
    recording: {
      events: [{ type: 'start', data: { inputs: { input: { value: input } } } }],
    },
    strings: {},
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('unclaimed page-completion work expires and explicit cancellation never receives grace', async () => {
  for (const reason of [RECORDING_INPUT_PAGE_COMPLETE, undefined]) {
    const cache = new WorkflowRecordingInputCache({ pageCompletionGraceMs: 1 });
    const controller = new AbortController();
    let aborted!: () => void;
    const wasAborted = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const result = cache.getOrLoad(
      'abandoned',
      async (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted();
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      controller.signal,
    );
    await Promise.resolve();
    controller.abort(reason);
    await assert.rejects(result, { name: 'AbortError' });
    // Keep the test process alive without relying on the unref'ed grace timer.
    const timeout = setTimeout(() => {
      throw new Error('Abandoned load did not cancel');
    }, 5000);
    try {
      await wasAborted;
    } finally {
      clearTimeout(timeout);
    }
  }
});

test('recording input cache reuses valid extracted inputs and expires them safely', async () => {
  let now = 100;
  const cache = new WorkflowRecordingInputCache({ ttlMs: 50, now: () => now });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return createSerializedRecording({ requestId: 'cached' });
  };

  assert.deepEqual(await cache.getOrLoad('recording', load), { exists: true, value: { requestId: 'cached' } });
  assert.deepEqual(await cache.getOrLoad('recording', load), { exists: true, value: { requestId: 'cached' } });
  assert.equal(loads, 1);

  now += 50;
  await cache.getOrLoad('recording', load);
  assert.equal(loads, 2);
});

test('recording input cache keeps LRU retention bounded and expires entries on access', async () => {
  let now = 0;
  const cache = new WorkflowRecordingInputCache({ maxEntries: 2, ttlMs: 10, now: () => now });
  let loads = 0;
  const load = (value: string) => async () => {
    loads += 1;
    return createSerializedRecording(value);
  };

  await cache.getOrLoad('first', load('first'));
  await cache.getOrLoad('second', load('second'));
  // Re-accessing first makes second the least-recently used completed entry.
  await cache.getOrLoad('first', load('unexpected'));
  await cache.getOrLoad('third', load('third'));
  await cache.getOrLoad('second', load('second-reloaded'));
  assert.equal(loads, 4);

  const expiringCache = new WorkflowRecordingInputCache({ maxEntries: 3, ttlMs: 10, now: () => now });
  await expiringCache.getOrLoad('expiring', load('expiring'));
  now = 10;
  await expiringCache.getOrLoad('expiring', load('expiring-reloaded'));
  assert.equal(loads, 6);
});

test('recording input cache keeps valid no-input recordings but reports malformed artifacts without caching them', async () => {
  const cache = new WorkflowRecordingInputCache();
  let missingLoads = 0;
  const missing = async () => {
    missingLoads += 1;
    return JSON.stringify({ recording: { events: [] }, strings: {} });
  };
  assert.deepEqual(await cache.getOrLoad('missing-input', missing), { exists: false, value: undefined });
  await cache.getOrLoad('missing-input', missing);
  assert.equal(missingLoads, 1);

  let malformedLoads = 0;
  const malformed = async () => {
    malformedLoads += 1;
    return '{not-json';
  };
  await assert.rejects(cache.getOrLoad('malformed', malformed), /Malformed recording artifact/);
  await assert.rejects(cache.getOrLoad('malformed', malformed), /Malformed recording artifact/);
  assert.equal(malformedLoads, 2);
});

test('recording input cache bounds complete cold read-and-extract work across searches', async () => {
  const cache = new WorkflowRecordingInputCache({ maxConcurrentLoads: 1 });
  let releaseFirstLoad: (() => void) | undefined;
  const firstLoadStarted = new Promise<void>((resolve) => {
    releaseFirstLoad = resolve;
  });
  let secondLoadStarted = false;

  const first = cache.getOrLoad('first', async () => {
    await firstLoadStarted;
    return createSerializedRecording('first');
  });
  await Promise.resolve();

  const second = cache.getOrLoad('second', async () => {
    secondLoadStarted = true;
    return createSerializedRecording('second');
  });
  await Promise.resolve();
  assert.equal(secondLoadStarted, false);

  releaseFirstLoad?.();
  await first;
  await second;
  assert.equal(secondLoadStarted, true);
});

test('recording input cache hands a released slot to the queued search before a new search', async () => {
  const cache = new WorkflowRecordingInputCache({ maxConcurrentLoads: 1 });
  let releaseFirstLoad: (() => void) | undefined;
  const firstLoadStarted = new Promise<void>((resolve) => {
    releaseFirstLoad = resolve;
  });
  let releaseSecondLoad: (() => void) | undefined;
  const secondLoadStarted = new Promise<void>((resolve) => {
    releaseSecondLoad = resolve;
  });
  let thirdLoadStarted = false;

  const first = cache.getOrLoad('first', async () => {
    await firstLoadStarted;
    return createSerializedRecording('first');
  });
  const second = cache.getOrLoad('second', async () => {
    await secondLoadStarted;
    return createSerializedRecording('second');
  });
  await Promise.resolve();

  releaseFirstLoad?.();
  // Let the first operation hand its slot to `second`, but submit `third`
  // before the queued operation resumes its microtask.
  await Promise.resolve();
  const third = cache.getOrLoad('third', async () => {
    thirdLoadStarted = true;
    return createSerializedRecording('third');
  });
  await Promise.resolve();

  assert.equal(thirdLoadStarted, false);
  releaseSecondLoad?.();
  await Promise.all([first, second, third]);
  assert.equal(thirdLoadStarted, true);
});

test('recording input cache removes an aborted cold search from the load queue', async () => {
  const cache = new WorkflowRecordingInputCache({ maxConcurrentLoads: 1 });
  let releaseFirstLoad: (() => void) | undefined;
  const firstLoadStarted = new Promise<void>((resolve) => {
    releaseFirstLoad = resolve;
  });
  const first = cache.getOrLoad('first', async () => {
    await firstLoadStarted;
    return createSerializedRecording('first');
  });
  await Promise.resolve();

  const abortController = new AbortController();
  let queuedLoadStarted = false;
  const queued = cache.getOrLoad(
    'queued',
    async () => {
      queuedLoadStarted = true;
      return createSerializedRecording('queued');
    },
    abortController.signal,
  );
  await Promise.resolve();
  abortController.abort();

  await assert.rejects(queued, { name: 'AbortError' });
  releaseFirstLoad?.();
  await first;
  await Promise.resolve();

  assert.equal(queuedLoadStarted, false);
});

test('aborting one shared cold-search consumer preserves the other consumer', async () => {
  const cache = new WorkflowRecordingInputCache({ maxConcurrentLoads: 1 });
  let releaseLoad: (() => void) | undefined;
  const loadStarted = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const abortController = new AbortController();
  let loads = 0;
  const first = cache.getOrLoad(
    'shared',
    async () => {
      loads += 1;
      await loadStarted;
      return createSerializedRecording('shared');
    },
    abortController.signal,
  );
  const second = cache.getOrLoad('shared', async () => {
    loads += 1;
    return createSerializedRecording('unexpected');
  });
  await Promise.resolve();
  abortController.abort();

  await assert.rejects(first, { name: 'AbortError' });
  releaseLoad?.();
  assert.deepEqual(await second, { exists: true, value: 'shared' });
  assert.equal(loads, 1);
});

test('invalidating an in-flight recording prevents its stale input from being cached', async () => {
  const cache = new WorkflowRecordingInputCache();
  let releaseLoad: (() => void) | undefined;
  const loadStarted = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let loads = 0;
  const first = cache.getOrLoad('filesystem:C:/recordings/one\\0gzip\\01\\01', async () => {
    loads += 1;
    await loadStarted;
    return createSerializedRecording('stale');
  });
  await Promise.resolve();

  cache.invalidateByPrefix('filesystem:C:/recordings/one\\0');
  releaseLoad?.();
  assert.deepEqual(await first, { exists: true, value: 'stale' });

  assert.deepEqual(
    await cache.getOrLoad('filesystem:C:/recordings/one\\0gzip\\01\\01', async () => {
      loads += 1;
      return createSerializedRecording('fresh');
    }),
    { exists: true, value: 'fresh' },
  );
  assert.equal(loads, 2);
});

test('invalidated loads cannot overwrite replacements in either completion order', async () => {
  for (const reset of ['invalidate', 'clear'] as const) {
    for (const firstToFinish of ['old', 'fresh'] as const) {
      const cache = new WorkflowRecordingInputCache();
      const oldSource = deferred<string>();
      const freshSource = deferred<string>();
      const started = deferred<void>();
      const old = cache.getOrLoad('same-key', async () => {
        started.resolve();
        return oldSource.promise;
      });
      await started.promise;
      if (reset === 'invalidate') cache.invalidate('same-key');
      else {
        cache.clear();
        cache.clear();
      }
      let freshLoads = 0;
      const fresh = cache.getOrLoad('same-key', async () => {
        freshLoads++;
        return freshSource.promise;
      });
      if (firstToFinish === 'old') {
        oldSource.resolve(createSerializedRecording('old'));
        await old;
        freshSource.resolve(createSerializedRecording('fresh'));
      } else {
        freshSource.resolve(createSerializedRecording('fresh'));
        await fresh;
        oldSource.resolve(createSerializedRecording('old'));
      }
      assert.deepEqual(await old, { exists: true, value: 'old' });
      assert.deepEqual(await fresh, { exists: true, value: 'fresh' });
      assert.equal(freshLoads, 1);
      assert.deepEqual(
        await cache.getOrLoad('same-key', async () => {
          throw new Error('The fresh result should remain cached');
        }),
        { exists: true, value: 'fresh' },
      );
    }
  }
});

test('repeated clear detaches each active generation and preserves only the newest cache entry', async () => {
  const cache = new WorkflowRecordingInputCache();
  const sources = [deferred<string>(), deferred<string>(), deferred<string>()];
  const results = sources.map((source, index) => {
    if (index > 0) cache.clear();
    return cache.getOrLoad('key', async () => source.promise);
  });
  for (const index of [2, 1, 0]) {
    sources[index]!.resolve(createSerializedRecording(index));
    assert.equal((await results[index])?.value, index);
  }
  assert.equal(
    (
      await cache.getOrLoad('key', async () => {
        throw new Error('cache miss');
      })
    )?.value,
    2,
  );
});

test('one detached consumer cancelling leaves the other consumer alive but cannot repopulate the cache', async () => {
  const cache = new WorkflowRecordingInputCache();
  const source = deferred<string>();
  const started = deferred<void>();
  const controller = new AbortController();
  let readSignal!: AbortSignal;
  const old = cache.getOrLoad(
    'key',
    async (signal) => {
      readSignal = signal;
      started.resolve();
      return source.promise;
    },
    controller.signal,
  );
  const shared = cache.getOrLoad('key', async () => {
    throw new Error('duplicate load');
  });
  await started.promise;
  cache.invalidate('key');
  controller.abort();
  await assert.rejects(old, { name: 'AbortError' });
  assert.equal(readSignal.aborted, false);
  // A failed replacement must not revive the detached result as a fallback.
  await assert.rejects(
    cache.getOrLoad('key', async () => {
      throw new Error('replacement failed');
    }),
    /replacement failed/,
  );
  source.resolve(createSerializedRecording('old'));
  assert.equal((await shared)?.value, 'old');
  assert.equal((await cache.getOrLoad('key', async () => createSerializedRecording('fresh')))?.value, 'fresh');
});

test('invalidation cancels unclaimed pagination-grace work immediately', async () => {
  const cache = new WorkflowRecordingInputCache({ pageCompletionGraceMs: 60_000 });
  const started = deferred<void>();
  const source = deferred<string>();
  const controller = new AbortController();
  let readSignal!: AbortSignal;
  const result = cache.getOrLoad(
    'key',
    async (signal) => {
      readSignal = signal;
      started.resolve();
      return source.promise;
    },
    controller.signal,
  );
  await started.promise;
  controller.abort(RECORDING_INPUT_PAGE_COMPLETE);
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(readSignal.aborted, false);
  cache.invalidate('key');
  assert.equal(readSignal.aborted, true);
  source.resolve(createSerializedRecording('old'));
  assert.equal((await cache.getOrLoad('key', async () => createSerializedRecording('fresh')))?.value, 'fresh');
});

test('the last consumer can cancel a load after invalidation detached it', async () => {
  const cache = new WorkflowRecordingInputCache();
  const controller = new AbortController();
  let readSignal!: AbortSignal;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = cache.getOrLoad(
    'detached',
    async (signal) => {
      readSignal = signal;
      await pending;
      return createSerializedRecording('old');
    },
    controller.signal,
  );
  await Promise.resolve();
  cache.invalidate('detached');
  controller.abort();
  try {
    await assert.rejects(old, { name: 'AbortError' });
    assert.equal(readSignal.aborted, true);
  } finally {
    release();
  }
});

test('large recordings with small extracted inputs remain cacheable', async () => {
  const small = createSerializedRecording('small');
  const largeRecordingWithSmallInput = JSON.stringify({
    version: 1,
    recording: {
      events: [
        { type: 'start', data: { inputs: { input: { value: 'small-input' } } } },
        { type: 'nodeOutput', data: { value: 'x'.repeat(8_192) } },
      ],
    },
    strings: {},
  });
  const cache = new WorkflowRecordingInputCache({
    maxBytes: 512,
    maxEntryBytes: 1_024,
  });
  let smallLoads = 0;

  await cache.getOrLoad('small', async () => {
    smallLoads += 1;
    return small;
  });
  await cache.getOrLoad('large-recording', async () => largeRecordingWithSmallInput);
  await cache.getOrLoad('small', async () => {
    smallLoads += 1;
    return small;
  });

  assert.equal(smallLoads, 1);
  assert.equal(
    await cache
      .getOrLoad('large-recording', async () => {
        throw new Error('large source recording should have been cached by its extracted input');
      })
      .then((input) => input?.value),
    'small-input',
  );
});

test('recording input extraction accepts compressed artifact bytes without changing input semantics', async () => {
  const serialized = createSerializedRecording({ requestId: 'worker-bytes', nested: ['retained'] });
  const compressed = gzipSync(Buffer.from(serialized, 'utf8'));
  const cache = new WorkflowRecordingInputCache();

  assert.deepEqual(
    extractWorkflowRecordingInputFromSource({
      kind: 'artifact',
      bytes: compressed,
      encoding: 'gzip',
    }),
    { exists: true, value: { requestId: 'worker-bytes', nested: ['retained'] } },
  );

  assert.deepEqual(
    await cache.getOrLoad('gzip-artifact', async () => ({
      kind: 'artifact' as const,
      bytes: gzipSync(Buffer.from(serialized, 'utf8')),
      encoding: 'gzip' as const,
    })),
    { exists: true, value: { requestId: 'worker-bytes', nested: ['retained'] } },
  );
});

test('recording input extraction reports diagnostics without coupling them to search correctness', async () => {
  const serialized = createSerializedRecording({ requestId: 'timed' });
  const timings: Array<{
    decompressionMs: number;
    parseAndExtractMs: number;
    workerQueueAndTransferMs: number;
  }> = [];
  const cache = new WorkflowRecordingInputCache({
    onExtractionTiming: (timing) => {
      timings.push(timing);
      throw new Error('A diagnostic observer must not affect extraction.');
    },
  });

  assert.deepEqual(
    await cache.getOrLoad('timed-artifact', async () => ({
      kind: 'artifact' as const,
      bytes: gzipSync(Buffer.from(serialized, 'utf8')),
      encoding: 'gzip' as const,
    })),
    { exists: true, value: { requestId: 'timed' } },
  );
  assert.equal(timings.length, 1);
  assert.ok(timings[0]!.decompressionMs >= 0);
  assert.ok(timings[0]!.parseAndExtractMs >= 0);
  assert.ok(timings[0]!.workerQueueAndTransferMs >= 0);
});

test('corrupt compressed input artifacts fail visibly and are never cached as non-matches', async () => {
  const cache = new WorkflowRecordingInputCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return {
      kind: 'artifact' as const,
      bytes: Uint8Array.from([0x00, 0x01, 0x02]),
      encoding: 'gzip' as const,
    };
  };

  await assert.rejects(cache.getOrLoad('corrupt-gzip', load));
  await assert.rejects(cache.getOrLoad('corrupt-gzip', load));
  assert.equal(loads, 2);
});

test('managed recording input cache keys are isolated by their storage owner', () => {
  const firstStore = {};
  const secondStore = {};

  assert.equal(
    getManagedRecordingInputCacheKey(firstStore, 'recordings/shared.json.gz'),
    getManagedRecordingInputCacheKey(firstStore, 'recordings/shared.json.gz'),
  );
  assert.notEqual(
    getManagedRecordingInputCacheKey(firstStore, 'recordings/shared.json.gz'),
    getManagedRecordingInputCacheKey(secondStore, 'recordings/shared.json.gz'),
  );
});
