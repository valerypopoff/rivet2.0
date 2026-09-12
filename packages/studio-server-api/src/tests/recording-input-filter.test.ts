import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterRecordingInputWindows,
  filterRowsByRecordingInputPage,
  createWorkflowRecordingInputAfter,
  filterRowsBySerializedRecordingInput,
  filterRowsBySerializedRecordingInputPage,
  matchesWorkflowRecordingSerializedInputFilter,
  normalizeWorkflowRecordingInputFilter,
  parseWorkflowRecordingInputAfter,
} from '../routes/workflows/recording-input-filter.js';

test('input search batches sparse metadata windows under one request budget', async () => {
  const rows = Array.from({ length: 1000 }, (_, id) => ({ id }));
  let queries = 0;
  const page = await filterRecordingInputWindows(
    { path: '$', operator: '==', value: '999' },
    async (_after, offset, limit) => {
      queries++;
      return rows.slice(offset, offset + limit);
    },
    async (row) => ({ exists: true, value: row.id }),
    { pageSize: 20, inputCursor: 0, now: () => 0, getInputAfter: (row) => String(row.id) },
  );
  assert.deepEqual(page.rows, [{ id: 999 }]);
  assert.equal(page.hasMore, false);
  assert.equal(page.analyzedRuns, 1000);
  assert.equal(page.totalRunsExact, true);
  assert.equal(queries, 7);
});

test('continuations progress when metadata consumed their budget and drain ready ordered results', async () => {
  let now = 0;
  const rows = [{ id: 1 }, { id: 2 }];
  const result = await filterRowsByRecordingInputPage(
    rows,
    { path: '$', operator: 'exists', value: '' },
    async (row) => ({ exists: true, value: row.id }),
    {
      cursor: 0,
      cursorBase: 24,
      pageSize: 20,
      scanBudgetMs: 150,
      now: () => {
        const value = now;
        now += 151;
        return value;
      },
    },
  );
  assert.deepEqual(result.rows, [rows[0]]);
  assert.equal(result.analyzedRuns, 25);
  assert.equal(result.nextInputCursor, 25);
  now = 0;
  const ready = await filterRowsByRecordingInputPage(
    rows,
    { path: '$', operator: 'exists', value: '' },
    async (row) => {
      queueMicrotask(() => {
        now = 200;
      });
      return { exists: true, value: row.id };
    },
    { cursor: 0, pageSize: 20, scanBudgetMs: 150, now: () => now },
  );
  assert.deepEqual(ready.rows, rows);
});

test('multi-window search retains filled continuation pages and cancellation between windows', async () => {
  const rows = Array.from({ length: 1000 }, (_, id) => ({ id }));
  let cursor = 0;
  let after: string | undefined;
  let calls = 0;
  const found: number[] = [];
  do {
    const page = await filterRecordingInputWindows(
      { path: '$', operator: 'exists', value: '' },
      async (_after, offset, limit) => rows.slice(offset, offset + limit),
      async (row) => ({ exists: true, value: row.id }),
      { inputCursor: cursor, inputAfter: after, pageSize: 20, now: () => 0, getInputAfter: (row) => String(row.id) },
    );
    found.push(...page.rows.map((row) => row.id));
    calls++;
    if (!page.hasMore) break;
    cursor = page.nextInputCursor!;
    after = page.nextInputAfter;
  } while (true);
  assert.deepEqual(
    found,
    rows.map((row) => row.id),
  );
  assert.equal(calls, 51);
  const controller = new AbortController();
  await assert.rejects(
    filterRecordingInputWindows(
      { path: '$', operator: 'exists', value: '' },
      async () => {
        controller.abort();
        return rows;
      },
      async () => {
        throw new Error('must not read');
      },
      { inputCursor: 0, pageSize: 20, signal: controller.signal, getInputAfter: () => '' },
    ),
    { name: 'AbortError' },
  );
});

function createSerializedRecording(input: unknown, strings: Record<string, string> = {}): string {
  return createSerializedRecordingWithInputs(
    {
      input: {
        type: 'any',
        value: input,
      },
    },
    strings,
  );
}

function createSerializedRecordingWithInputs(
  inputs: Record<string, unknown>,
  strings: Record<string, string> = {},
): string {
  return JSON.stringify({
    version: 1,
    recording: {
      recordingId: 'recording-filter-test',
      events: [
        {
          type: 'start',
          data: {
            inputs,
          },
          ts: 1,
        },
      ],
      startTs: 1,
      finishTs: 1,
    },
    assets: {},
    strings,
  });
}

test('recording input filters use the workflow request input as the JSON path root', () => {
  const serializedRecording = createSerializedRecording({ foo: 'bar', score: 12 });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.foo', operator: '==', value: 'bar' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.foo',
      operator: '==',
      value: ' bar ',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.score', operator: '>', value: '10' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: 'exists',
      value: '',
    }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: 'not_exists',
      value: '',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: '!=',
      value: 'bar',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: '==',
      value: 'undefined',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: '!=',
      value: 'undefined',
    }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: 'contains',
      value: 'undefined',
    }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: 'contains',
      value: '',
    }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: 'contains',
      value: '"undefined"',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: '>',
      value: '0',
    }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.missing',
      operator: '>=',
      value: 'undefined',
    }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: '==',
      value: '{"score":12,"foo":"bar"}',
    }),
    true,
  );
});

test('recording input contains stringifies the left operand when filtering with a string', () => {
  const serializedRecording = createSerializedRecording({
    foo: 'foobar',
    items: ['alpha', 'beta'],
    score: 12,
  });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: '"foobar"',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: 'foobar',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: "'foobar'",
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: '"items"',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.items',
      operator: 'contains',
      value: 'alpha',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.score',
      operator: 'contains',
      value: '"12"',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(createSerializedRecording({}), {
      path: '$',
      operator: 'contains',
      value: '',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(createSerializedRecording([]), {
      path: '$',
      operator: 'contains',
      value: '',
    }),
    true,
  );
});

test('recording input contains searches object text recursively without JSON escaping', () => {
  const serializedRecording = createSerializedRecording({
    foo: {
      title: 'nested object',
      payload: {
        message: 'first line\nfoobar "quoted" value',
      },
    },
  });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.foo',
      operator: 'contains',
      value: 'foobar',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: 'foobar "quoted" value',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: 'first line\nfoobar',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: String.raw`first line\nfoobar`,
    }),
    false,
  );
});

test('recording input filters fall back to named graph inputs when no input port exists', () => {
  const serializedRecording = createSerializedRecordingWithInputs({
    prompt: {
      type: 'any',
      value: 'hello from web app',
    },
    score: {
      type: 'number',
      value: 42,
    },
  });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.prompt',
      operator: '==',
      value: 'hello from web app',
    }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.score', operator: '>', value: '40' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$',
      operator: 'contains',
      value: 'web app',
    }),
    true,
  );
});

test('recording input filters restore serialized string table references before matching', () => {
  const serializedRecording = createSerializedRecording({ foo: '$STRING:1234' }, { 1234: 'a long stored value' });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.foo',
      operator: 'contains',
      value: 'stored',
    }),
    true,
  );
});

test('recording input filters do not match recordings without a captured root input', () => {
  const serializedRecording = JSON.stringify({
    version: 1,
    recording: {
      recordingId: 'missing-input-recording',
      events: [],
      startTs: 1,
      finishTs: 1,
    },
    assets: {},
    strings: {},
  });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, {
      path: '$.foo',
      operator: 'not_exists',
      value: '',
    }),
    false,
  );
});

test('recording input filter normalization rejects invalid paths and operators', () => {
  assert.deepEqual(normalizeWorkflowRecordingInputFilter({ path: ' $.foo ', operator: undefined, value: 'bar' }), {
    path: '$.foo',
    operator: '==',
    value: 'bar',
  });
  assert.throws(
    () => normalizeWorkflowRecordingInputFilter({ path: 'foo', operator: '==', value: 'bar' }),
    /must start with \$/,
  );
  assert.throws(
    () => normalizeWorkflowRecordingInputFilter({ path: '$.foo', operator: 'roughly', value: 'bar' }),
    /Unsupported recording input filter operator/,
  );
});

test('recording input row filtering preserves order and bounds artifact reads', async () => {
  const rows = [
    { id: 'first', serialized: createSerializedRecording({ foo: 'bar' }) },
    { id: 'second', serialized: createSerializedRecording({ foo: 'baz' }) },
    { id: 'third', serialized: createSerializedRecording({ foo: 'bar' }) },
  ];

  const filteredRows = await filterRowsBySerializedRecordingInput(
    rows,
    { path: '$.foo', operator: '==', value: 'bar' },
    async (row) => row.serialized,
  );

  assert.deepEqual(
    filteredRows.map((row) => row.id),
    ['first', 'third'],
  );
});

test('recording input page filtering returns recent matches before scanning full history', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording(index === 0 ? { request_id: 'recent' } : { request_id: `older-${index}` }),
  }));
  let readCount = 0;

  const filteredPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: '==', value: 'recent' },
    async (row) => {
      readCount += 1;
      return row.serialized;
    },
    { cursor: 0, pageSize: 5, settleCandidateCount: 5 },
  );

  assert.deepEqual(
    filteredPage.rows.map((row) => row.id),
    ['row-0'],
  );
  assert.equal(filteredPage.totalRunsExact, false);
  assert.equal(filteredPage.hasMore, true);
  assert.equal(filteredPage.nextInputCursor, readCount);
  assert.ok(readCount < rows.length);
});

test('recording input continuations are opaque, scoped, and reject changed searches', () => {
  const filter = { path: '$.request_id', operator: '==', value: 'needle' } as const;
  const continuation = createWorkflowRecordingInputAfter(
    { createdAt: '2026-09-12T10:20:30.000Z', recordingId: 'recording-42', legacyCursor: 42 },
    { workflowId: 'workflow-1', statusFilter: 'all', filter },
  );

  assert.deepEqual(
    parseWorkflowRecordingInputAfter(continuation, { workflowId: 'workflow-1', statusFilter: 'all', filter }),
    { createdAt: '2026-09-12T10:20:30.000Z', recordingId: 'recording-42', legacyCursor: 42 },
  );
  const legacyContinuation = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(continuation, 'base64url').toString('utf8')),
      version: 1,
    }),
    'utf8',
  ).toString('base64url');
  assert.deepEqual(
    parseWorkflowRecordingInputAfter(legacyContinuation, { workflowId: 'workflow-1', statusFilter: 'all', filter }),
    { createdAt: '2026-09-12T10:20:30.000Z', recordingId: 'recording-42', legacyCursor: 0 },
  );
  assert.throws(
    () =>
      parseWorkflowRecordingInputAfter(continuation, {
        workflowId: 'workflow-1',
        statusFilter: 'failed',
        filter,
      }),
    /does not match this search/,
  );
  assert.throws(
    () =>
      parseWorkflowRecordingInputAfter(continuation, {
        workflowId: 'workflow-1',
        statusFilter: 'all',
        filter: { ...filter, value: 'different' },
      }),
    /does not match this search/,
  );
});

test('recording input page filtering returns a newest matching run before older artifacts are read', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording(index === 0 ? { request_id: 'recent' } : { request_id: `older-${index}` }),
  }));
  let readCount = 0;

  const filteredPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: '==', value: 'recent' },
    async (row) => {
      readCount += 1;
      return row.serialized;
    },
    {
      cursor: 0,
      pageSize: 20,
      probeFirstCandidate: true,
      isInitialSearch: true,
    },
  );

  assert.deepEqual(
    filteredPage.rows.map((row) => row.id),
    ['row-0'],
  );
  assert.equal(readCount, 1);
  assert.equal(filteredPage.nextInputCursor, 1);
  assert.equal(filteredPage.totalRunsExact, false);
  assert.equal(filteredPage.hasMore, true);
});

test('an initial input search consumes already-ready nearby matches without waiting for older work', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording(
      index === 9 ? { request_id: 'recent-enough' } : { request_id: `older-${index}` },
    ),
  }));
  let readCount = 0;

  const filteredPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: '==', value: 'recent-enough' },
    async (row) => {
      readCount += 1;
      return row.serialized;
    },
    {
      cursor: 0,
      pageSize: 20,
      settleCandidateCount: 24,
      probeFirstCandidate: true,
      isInitialSearch: true,
    },
  );

  assert.deepEqual(
    filteredPage.rows.map((row) => row.id),
    ['row-9'],
  );
  // The one-record newest probe is followed by bounded concurrent reads. The
  // first match returns promptly rather than waiting on still-pending older
  // artifacts, and the cursor remains exactly at that consumed row.
  assert.equal(readCount, 17);
  assert.equal(filteredPage.nextInputCursor, 17);
  assert.equal(filteredPage.hasMore, true);
});

test('continuations fill a page instead of returning one matching recording per request', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording({ request_id: `match-${index}` }),
  }));
  let readCount = 0;

  const filteredPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: 'exists', value: '' },
    async (row) => {
      readCount += 1;
      return row.serialized;
    },
    { cursor: 0, pageSize: 5, settleCandidateCount: 24, isInitialSearch: false },
  );

  assert.deepEqual(
    filteredPage.rows.map((row) => row.id),
    ['row-0', 'row-1', 'row-2', 'row-3', 'row-4'],
  );
  assert.equal(readCount, 5);
  assert.equal(filteredPage.nextInputCursor, 5);
});

for (const continuationSize of [20, 100])
  test(`dense cached history fills ${continuationSize}-row continuations`, async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      id: `row-${index}`,
      serialized: createSerializedRecording({ request_id: `match-${index}` }),
    }));
    let cursor = 0;
    let requestCount = 0;
    const receivedIds: string[] = [];

    do {
      const page = await filterRowsBySerializedRecordingInputPage(
        rows,
        { path: '$.request_id', operator: 'exists', value: '' },
        async (row) => row.serialized,
        {
          cursor,
          pageSize: cursor === 0 ? 20 : continuationSize,
          settleCandidateCount: Math.max(24, continuationSize),
          probeFirstCandidate: cursor === 0,
          isInitialSearch: cursor === 0,
        },
      );
      requestCount += 1;
      receivedIds.push(...page.rows.map((row) => row.id));
      if (!page.hasMore) {
        break;
      }
      cursor = page.nextInputCursor!;
    } while (true);

    assert.equal(requestCount, continuationSize === 20 ? 51 : 11);
    assert.deepEqual(
      receivedIds,
      rows.map((row) => row.id),
    );
  });

test('the scan budget stops further scheduling after the current ordered read completes', async () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording({ request_id: `miss-${index}` }),
  }));
  let now = 0;
  let readCount = 0;
  let releaseFirstRead: (() => void) | undefined;
  const firstReadGate = new Promise<void>((resolve) => {
    releaseFirstRead = resolve;
  });

  const filteredPagePromise = filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: '==', value: 'missing' },
    async (row) => {
      readCount += 1;
      if (row.id === 'row-0') {
        await firstReadGate;
        now = 200;
      }
      return row.serialized;
    },
    {
      cursor: 0,
      pageSize: 20,
      settleCandidateCount: 24,
      scanBudgetMs: 150,
      now: () => now,
    },
  );

  await Promise.resolve();
  assert.equal(readCount, 8);
  releaseFirstRead?.();
  const filteredPage = await filteredPagePromise;

  assert.equal(readCount, 8);
  assert.equal(filteredPage.nextInputCursor, 8);
  assert.equal(filteredPage.hasMore, true);
});

test('recording input page filtering advances the cursor through chunks with no matches', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording({ request_id: `older-${index}` }),
  }));
  let readCount = 0;

  const filteredPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: '==', value: 'missing' },
    async (row) => {
      readCount += 1;
      return row.serialized;
    },
    { cursor: 0, pageSize: 5, settleCandidateCount: 5 },
  );

  assert.deepEqual(filteredPage.rows, []);
  assert.equal(filteredPage.totalRunsExact, false);
  assert.equal(filteredPage.hasMore, true);
  assert.equal(filteredPage.nextInputCursor, readCount);
  assert.ok(readCount < rows.length);
});

test('recording input page filtering resumes without skipping extra matches from a read batch', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording({ request_id: `match-${index}` }),
  }));

  const firstPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: 'exists', value: '' },
    async (row) => row.serialized,
    { cursor: 0, pageSize: 2 },
  );
  const secondPage = await filterRowsBySerializedRecordingInputPage(
    rows,
    { path: '$.request_id', operator: 'exists', value: '' },
    async (row) => row.serialized,
    { cursor: firstPage.nextInputCursor ?? 0, pageSize: 2 },
  );

  assert.deepEqual(
    firstPage.rows.map((row) => row.id),
    ['row-0', 'row-1'],
  );
  assert.equal(firstPage.nextInputCursor, 2);
  assert.deepEqual(
    secondPage.rows.map((row) => row.id),
    ['row-2', 'row-3'],
  );
});

test('recording input page filtering aborts the scan between artifact reads', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `row-${index}`,
    serialized: createSerializedRecording({ request_id: `match-${index}` }),
  }));
  const abortController = new AbortController();
  let readCount = 0;

  await assert.rejects(
    filterRowsBySerializedRecordingInputPage(
      rows,
      { path: '$.request_id', operator: 'exists', value: '' },
      async (row) => {
        readCount += 1;
        abortController.abort();
        return row.serialized;
      },
      { cursor: 0, pageSize: 5, signal: abortController.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(readCount, 1);
});

test('recording input page filtering preserves an abort during the newest-run probe', async () => {
  const abortController = new AbortController();

  await assert.rejects(
    filterRowsBySerializedRecordingInputPage(
      [{ id: 'newest', serialized: createSerializedRecording({ request_id: 'newest' }) }],
      { path: '$.request_id', operator: '==', value: 'newest' },
      async (row) => {
        abortController.abort();
        return row.serialized;
      },
      { cursor: 0, pageSize: 20, probeFirstCandidate: true, signal: abortController.signal },
    ),
    { name: 'AbortError' },
  );
});

test('recording input page filtering reports an unreadable artifact instead of hiding it as a non-match', async () => {
  await assert.rejects(
    filterRowsBySerializedRecordingInputPage(
      [{ id: 'unreadable', serialized: createSerializedRecording({ request_id: 'recent' }) }],
      { path: '$.request_id', operator: '==', value: 'recent' },
      async () => {
        throw new Error('Object storage temporarily unavailable');
      },
      { cursor: 0, pageSize: 20, probeFirstCandidate: true },
    ),
    /Object storage temporarily unavailable/,
  );
});

test('full recording input filtering also reports an unreadable artifact', async () => {
  await assert.rejects(
    filterRowsBySerializedRecordingInput(
      [{ id: 'unreadable' }],
      { path: '$.request_id', operator: '==', value: 'recent' },
      async () => {
        throw new Error('Filesystem recording cannot be read');
      },
    ),
    /Filesystem recording cannot be read/,
  );
});

test('input filtering preserves even a falsy rejection instead of consuming a non-match', async () => {
  for (const failure of [undefined, null, false, 0, '']) {
    await assert.rejects(
      filterRowsByRecordingInputPage([0], { path: '$', operator: '==', value: '0' }, () => Promise.reject(failure), {
        cursor: 0,
        pageSize: 20,
      }),
      (error) => error === failure,
    );
  }
});

test('a synchronous artifact read failure is reported in cursor order', async () => {
  const failure = new Error('synchronous read failure');
  await assert.rejects(
    filterRowsByRecordingInputPage(
      [0],
      { path: '$', operator: 'exists', value: '' },
      () => {
        throw failure;
      },
      { cursor: 0, pageSize: 20 },
    ),
    (error) => error === failure,
  );
});

test('a speculative rejection beyond the response boundary cannot retroactively fail that page', async () => {
  const failure = new Error('older artifact unavailable');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = async (row: number) => {
    if (row === 0) return { exists: true, value: 'match' };
    if (row === 1) {
      await gate;
      return { exists: false, value: undefined };
    }
    throw failure;
  };
  try {
    const first = await filterRowsByRecordingInputPage([0, 1, 2], { path: '$', operator: 'exists', value: '' }, read, {
      cursor: 0,
      pageSize: 20,
      isInitialSearch: true,
    });
    assert.deepEqual(first.rows, [0]);
    assert.equal(first.nextInputCursor, 1);
    // Let the failure survive a full event-loop turn: node:test would report
    // any unhandled rejection even though the first page already returned.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await assert.rejects(
      filterRowsByRecordingInputPage([0, 1, 2], { path: '$', operator: 'exists', value: '' }, read, {
        cursor: first.nextInputCursor!,
        pageSize: 20,
      }),
      (error) => error === failure,
    );
  } finally {
    release();
  }
});

test('cancellation wins over a speculative failure while the required read is pending', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scan = filterRowsByRecordingInputPage(
    [0, 1],
    { path: '$', operator: 'exists', value: '' },
    async (row) => {
      if (row === 1) throw new Error('speculative failure');
      await gate;
      return { exists: true, value: 'match' };
    },
    { cursor: 0, pageSize: 20, signal: controller.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  release();
  await assert.rejects(scan, { name: 'AbortError' });
});

test('speculative matching failures are handled while the earlier candidate is pending', async () => {
  const failure = new Error('Matching failed');
  await assert.rejects(
    filterRowsByRecordingInputPage(
      [0, 1],
      { path: '$.value', operator: '==', value: 'match' },
      async (row) => {
        if (row === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { exists: true, value: { value: 'miss' } };
        }
        return {
          exists: true,
          value: {
            get value() {
              throw failure;
            },
          },
        };
      },
      { cursor: 0, pageSize: 20 },
    ),
    (error) => error === failure,
  );
});
