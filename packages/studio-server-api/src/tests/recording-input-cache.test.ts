import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  getManagedRecordingInputCacheKey,
  getRecordingInputCacheMaxBytes,
  WorkflowRecordingInputCache,
} from '../routes/workflows/recording-input-cache.js';
import { extractWorkflowRecordingInputFromSource } from '../routes/workflows/recording-input-source.js';
import {
  RECORDING_INPUT_PAGE_COMPLETE,
  isRequestIdInputFilter,
  matchesWorkflowRecordingInputFilter,
} from '../routes/workflows/recording-input-filter.js';

test('request-ID projections cover a long 25,000-record scan without retaining complete inputs', async () => {
  let now = 0;
  let reads = 0;
  const cache = new WorkflowRecordingInputCache({ now: () => now });
  const source = createSerializedRecording({ request_id: 'needle', payload: 'large unrelated input' });
  const key = (id: number) =>
    `managed:1:namespace/${'a'.repeat(36)}/workflows/${'b'.repeat(36)}/recordings/${String(id).padStart(36, '0')}/recording.json.artifact-v1.${'c'.repeat(64)}.100.500.gzip`;
  const load = async () => {
    reads++;
    return source;
  };
  for (let i = 0; i < 25_000; i++) {
    now += 80;
    await cache.getOrLoad(key(i), load, undefined, 1, { requestIdOnly: true, immutable: true });
  }
  now += 120_000;
  for (let i = 0; i < 25_000; i++) {
    const input = await cache.getOrLoad(key(i), load, undefined, 1, { requestIdOnly: true, immutable: true });
    assert.deepEqual(input, { exists: true, value: { request_id: 'needle' } });
  }
  assert.equal(reads, 25_000);
  assert.equal(cache.diagnostics.requestIdEntries, 25_000);
  assert.ok(cache.diagnostics.retainedBytes < 32 * 1024 * 1024);
  now = 3_600_081;
  await cache.getOrLoad(key(0), load, undefined, 1, { requestIdOnly: true, immutable: true });
  assert.equal(reads, 25_001);
});

test('projection selection preserves equality semantics and falls back for large or structured IDs', async () => {
  assert.equal(isRequestIdInputFilter({ path: "$['request_id']", operator: '==', value: '' }), true);
  for (const path of ['$.request_id.child', '$.requestId', '$'])
    assert.equal(isRequestIdInputFilter({ path, operator: '==', value: '' }), false);
  assert.equal(isRequestIdInputFilter({ path: '$.request_id', operator: 'contains', value: '' }), false);
  const values = [42, '042', 'true', true, false, null, undefined, { nested: 'value' }, [42], 'x'.repeat(5000)];
  for (const [i, value] of values.entries()) {
    const cache = new WorkflowRecordingInputCache();
    const source = createSerializedRecording({ request_id: value, unrelated: 'retained only by full readers' });
    const expected = extractWorkflowRecordingInputFromSource({ kind: 'serialized', serializedRecording: source })!;
    const projected = await cache.getOrLoad(`source-${i}`, async () => source, undefined, 1, { requestIdOnly: true });
    for (const searched of ['42', '042', 'true', 'false', 'null', 'undefined', '{"nested":"value"}', '[42]']) {
      const filter = { path: '$.request_id', operator: '==' as const, value: searched };
      assert.equal(
        matchesWorkflowRecordingInputFilter(projected!.value, filter),
        matchesWorkflowRecordingInputFilter(expected.value, filter),
      );
    }
    if (i >= 7) assert.deepEqual(projected, expected, 'unsupported projection keeps full matching behavior');
  }
});

test('projection and full consumers share reads without leaking partial inputs or retaining large payloads', async () => {
  const cache = new WorkflowRecordingInputCache();
  const source = createSerializedRecording({ request_id: 'needle', payload: 'x'.repeat(1024 * 1024 + 1) });
  let reads = 0;
  const pending = deferred<string>();
  const load = () => {
    reads++;
    return pending.promise;
  };
  const projected = cache.getOrLoad('same', load, undefined, 1, { requestIdOnly: true });
  const full = cache.getOrLoad('same', load, undefined, 1);
  pending.resolve(source);
  assert.deepEqual(await projected, { exists: true, value: { request_id: 'needle' } });
  assert.ok(((await full)!.value as { payload: string }).payload.length > 1024 * 1024);
  assert.equal(reads, 1);
  assert.equal(cache.diagnostics.requestIdEntries, 1);
  await cache.getOrLoad('same', load, undefined, 1, { requestIdOnly: true });
  assert.equal(reads, 1);
  await cache.getOrLoad('same', load, undefined, 1);
  assert.equal(reads, 2, 'a projection must not satisfy a full-input lookup');
});

test('projection reuses full cache, respects legacy expiry, and survives full-view eviction pressure', async () => {
  let now = 0,
    reads = 0;
  const cache = new WorkflowRecordingInputCache({ maxBytes: 4096, now: () => now, ttlMs: 100 });
  const load = async () => {
    reads++;
    return createSerializedRecording({ request_id: 'needle', payload: 'x'.repeat(1000) });
  };
  await cache.getOrLoad('legacy', load);
  now = 75;
  await cache.getOrLoad('legacy', load, undefined, 1, { requestIdOnly: true });
  assert.equal(reads, 1);
  for (let i = 0; i < 10; i++) await cache.getOrLoad(`full:${i}`, load);
  await cache.getOrLoad('legacy', load, undefined, 1, { requestIdOnly: true });
  assert.equal(reads, 11);
  assert.ok(cache.diagnostics.retainedBytes <= 4096);
  now = 101;
  await cache.getOrLoad('legacy', load, undefined, 1, { requestIdOnly: true });
  assert.equal(reads, 12, 'deriving from a full-cache hit must not extend the legacy source expiry');
  cache.invalidateByPrefix('legacy');
  assert.equal(cache.diagnostics.requestIdEntries, 0);
});

test('disabled cache and source invalidation cover projections and in-flight view publication', async () => {
  let reads = 0;
  const source = createSerializedRecording({ request_id: 'needle' });
  const disabled = new WorkflowRecordingInputCache({ maxBytes: 0 });
  for (let i = 0; i < 2; i++)
    await disabled.getOrLoad(
      'source',
      async () => {
        reads++;
        return source;
      },
      undefined,
      1,
      { requestIdOnly: true },
    );
  assert.equal(reads, 2);
  assert.equal(disabled.size, 0);
  const cache = new WorkflowRecordingInputCache();
  const pending = deferred<string>();
  const old = cache.getOrLoad('source', () => pending.promise, undefined, 1, { requestIdOnly: true, immutable: true });
  cache.invalidate('source');
  await cache.getOrLoad('source', async () => createSerializedRecording({ request_id: 'new' }), undefined, 1, {
    requestIdOnly: true,
    immutable: true,
  });
  pending.resolve(source);
  await old;
  assert.deepEqual(await cache.getOrLoad('source', async () => source, undefined, 1, { requestIdOnly: true }), {
    exists: true,
    value: { request_id: 'new' },
  });
  cache.clear();
  assert.equal(cache.size, 0);
});

test('a fresh full read replaces older projections, including absent and unreadable sources', async (t) => {
  for (const replacement of ['scalar', 'structured', 'missing', 'corrupt'] as const) {
    await t.test(replacement, async () => {
      const cache = new WorkflowRecordingInputCache();
      await cache.getOrLoad('mutable', async () => createSerializedRecording({ request_id: 'old' }), undefined, 1, {
        requestIdOnly: true,
      });
      const source =
        replacement === 'missing'
          ? null
          : replacement === 'corrupt'
            ? 'invalid JSON'
            : createSerializedRecording({ request_id: replacement === 'scalar' ? 'new' : { name: 'new' } });
      const load = async () => source;
      if (replacement === 'corrupt') {
        await assert.rejects(cache.getOrLoad('mutable', load), /Malformed recording/);
        await assert.rejects(
          cache.getOrLoad('mutable', load, undefined, 1, { requestIdOnly: true }),
          /Malformed recording/,
        );
      } else {
        await cache.getOrLoad('mutable', load);
        const result = await cache.getOrLoad('mutable', load, undefined, 1, { requestIdOnly: true });
        assert.deepEqual(
          result,
          source == null
            ? null
            : extractWorkflowRecordingInputFromSource({ kind: 'serialized', serializedRecording: source }),
        );
      }
    });
  }
});

test('later consumers cannot upgrade the trust or expiry of an unverified source read', async (t) => {
  for (const shared of [false, true]) {
    await t.test(shared ? 'in-flight read' : 'completed full input', async () => {
      let now = 0;
      const cache = new WorkflowRecordingInputCache({ ttlMs: 10, now: () => now });
      const pending = deferred<string>();
      const full = cache.getOrLoad('source', () => pending.promise);
      const project = () =>
        cache.getOrLoad('source', async () => createSerializedRecording({ request_id: 'new' }), undefined, 1, {
          requestIdOnly: true,
          immutable: true,
        });
      const joined = shared ? project() : undefined;
      pending.resolve(createSerializedRecording({ request_id: 'old' }));
      await full;
      if (joined) await joined;
      else {
        now = 5;
        await project();
      }
      now = 11;
      assert.deepEqual(await project(), { exists: true, value: { request_id: 'new' } });
    });
  }
});

test('a verified full-cache hit retains immutable projection expiry', async () => {
  let now = 0;
  const cache = new WorkflowRecordingInputCache({ ttlMs: 10, now: () => now });
  const source = createSerializedRecording({ request_id: 'verified' });
  await cache.getOrLoad('verified', async () => source, undefined, 1, { immutable: true });
  now = 5;
  await cache.getOrLoad(
    'verified',
    async () => {
      throw new Error('must use full cache');
    },
    undefined,
    1,
    { requestIdOnly: true },
  );
  now = 11;
  assert.deepEqual(
    await cache.getOrLoad(
      'verified',
      async () => {
        throw new Error('must use projection');
      },
      undefined,
      1,
      { requestIdOnly: true },
    ),
    { exists: true, value: { request_id: 'verified' } },
  );
});

test('replacing a full projection LRU does not also evict an unrelated full input', async () => {
  const cache = new WorkflowRecordingInputCache({ maxBytes: 4096, requestIdMaxEntries: 2 });
  const project = (key: string) =>
    cache.getOrLoad(key, async () => createSerializedRecording({ request_id: 'item' }), undefined, 1, {
      requestIdOnly: true,
    });
  await project('small-0');
  await project('small-1');
  let fullReads = 0;
  const load = async () => {
    fullReads++;
    return createSerializedRecording({ payload: 'x'.repeat(3600) });
  };
  await cache.getOrLoad('full', load);
  await project('small-2');
  await cache.getOrLoad('full', load);
  assert.equal(fullReads, 1);
  assert.equal(cache.diagnostics.requestIdEntries, 2);
  assert.ok(cache.diagnostics.retainedBytes <= 4096);
});

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

test('invalid decoded-size and UTF-8 artifacts cannot populate the completed input cache', async () => {
  const cache = new WorkflowRecordingInputCache();
  const text = JSON.stringify({ recording: { events: [] } });
  const invalidText = Buffer.concat([
    Buffer.from('{"recording":{"events":[]},"unused":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  const sources = [
    {
      kind: 'artifact' as const,
      encoding: 'gzip' as const,
      bytes: gzipSync(text),
      decodedBytes: Buffer.byteLength(text) + 1,
    },
    { kind: 'artifact' as const, encoding: 'identity' as const, bytes: invalidText },
  ];
  for (const [index, source] of sources.entries()) {
    let loads = 0;
    const key = `invalid-input-${index}`;
    const load = async () => {
      loads++;
      return source;
    };
    await assert.rejects(cache.getOrLoad(key, load));
    await assert.rejects(cache.getOrLoad(key, load));
    assert.equal(loads, 2);
    assert.deepEqual(
      await cache.getOrLoad(key, async () => ({
        kind: 'artifact',
        encoding: 'gzip',
        bytes: gzipSync(text),
        decodedBytes: Buffer.byteLength(text),
      })),
      { exists: false, value: undefined },
    );
  }
});
