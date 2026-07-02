import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterRowsBySerializedRecordingInput,
  filterRowsBySerializedRecordingInputPage,
  matchesWorkflowRecordingSerializedInputFilter,
  normalizeWorkflowRecordingInputFilter,
} from '../routes/workflows/recording-input-filter.js';

function createSerializedRecording(input: unknown, strings: Record<string, string> = {}): string {
  return createSerializedRecordingWithInputs({
    input: {
      type: 'any',
      value: input,
    },
  }, strings);
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
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.foo', operator: '==', value: ' bar ' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.score', operator: '>', value: '10' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'exists', value: '' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'not_exists', value: '' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: '!=', value: 'bar' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: '==', value: 'undefined' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: '!=', value: 'undefined' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'contains', value: 'undefined' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'contains', value: '' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: 'contains', value: '"undefined"' }),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: '>', value: '0' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(serializedRecording, { path: '$.missing', operator: '>=', value: 'undefined' }),
    false,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: '==', value: '{"score":12,"foo":"bar"}' },
    ),
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
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: 'contains', value: '"foobar"' },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: 'contains', value: 'foobar' },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: 'contains', value: "'foobar'" },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: 'contains', value: '"items"' },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.items', operator: 'contains', value: 'alpha' },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.score', operator: 'contains', value: '"12"' },
    ),
    true,
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
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.prompt', operator: '==', value: 'hello from web app' },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.score', operator: '>', value: '40' },
    ),
    true,
  );
  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$', operator: 'contains', value: 'web app' },
    ),
    true,
  );
});

test('recording input filters restore serialized string table references before matching', () => {
  const serializedRecording = createSerializedRecording({ foo: '$STRING:1234' }, { 1234: 'a long stored value' });

  assert.equal(
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.foo', operator: 'contains', value: 'stored' },
    ),
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
    matchesWorkflowRecordingSerializedInputFilter(
      serializedRecording,
      { path: '$.foo', operator: 'not_exists', value: '' },
    ),
    false,
  );
});

test('recording input filter normalization rejects invalid paths and operators', () => {
  assert.deepEqual(
    normalizeWorkflowRecordingInputFilter({ path: ' $.foo ', operator: undefined, value: 'bar' }),
    { path: '$.foo', operator: '==', value: 'bar' },
  );
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

  assert.deepEqual(filteredRows.map((row) => row.id), ['first', 'third']);
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

  assert.deepEqual(filteredPage.rows.map((row) => row.id), ['row-0']);
  assert.equal(filteredPage.totalRunsExact, false);
  assert.equal(filteredPage.hasMore, true);
  assert.equal(filteredPage.nextInputCursor, readCount);
  assert.ok(readCount < rows.length);
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

  assert.deepEqual(firstPage.rows.map((row) => row.id), ['row-0', 'row-1']);
  assert.equal(firstPage.nextInputCursor, 2);
  assert.deepEqual(secondPage.rows.map((row) => row.id), ['row-2', 'row-3']);
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
