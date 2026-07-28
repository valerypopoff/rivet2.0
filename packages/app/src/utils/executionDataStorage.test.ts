import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataValue, Outputs, PortId } from '@valerypopoff/rivet2-core';
import type { DataRefStore } from '../providers/ProvidersContext.js';
import {
  clearExecutionDataRefs,
  clearRemovedExecutionDataRefs,
  collectStoredRefIds,
  hasUnavailableStoredRefs,
  isPreviewOnlyStoredValue,
  restoreStoredDataValue,
  restoreStoredInputsOrOutputs,
  splitRunDataByPreservedNodes,
  storeDataValueForHistory,
  storeInputsOrOutputsForHistory,
  storeNodeDataForHistory,
} from './executionDataStorage.js';
import { REF_STORAGE_THRESHOLD_CHARS } from './outputStorageLimits.js';

function createDataRefStore(): DataRefStore & {
  values: Map<string, DataValue>;
  sizeHints: Map<string, number>;
} {
  const values = new Map<string, DataValue>();
  const sizeHints = new Map<string, number>();

  return {
    values,
    sizeHints,
    get: (key) => values.get(key),
    set: (key, value, options) => {
      values.set(key, value);
      if (options?.sizeHint != null) {
        sizeHints.set(key, options.sizeHint);
      }
    },
    delete: (key) => {
      values.delete(key);
      sizeHints.delete(key);
    },
  };
}

test('storeDataValueForHistory includes split index in ref ids for split outputs', () => {
  const dataRefs = createDataRefStore();

  const stored = storeDataValueForHistory(
    { type: 'string', value: 'x'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1) },
    dataRefs,
    {
      nodeId: 'node-split',
      processId: 'process-split',
      channel: 'output',
      splitIndex: 2,
    },
    'output' as PortId,
  );

  assert.equal(stored.storage, 'ref');
  assert.equal(stored.refId, 'execution:node-split:process-split:output:2:output');
  assert.equal(dataRefs.values.has(stored.refId), true);
});

test('isPreviewOnlyStoredValue folds only chat-message refs with text previews', () => {
  assert.equal(
    isPreviewOnlyStoredValue({
      type: 'chat-message',
      storage: 'ref',
      refId: 'large-chat',
      preview: {
        kind: 'text',
        excerpt: 'large result',
        totalChars: 20_000,
        lineCount: 1,
      },
    }),
    true,
  );
  assert.equal(
    isPreviewOnlyStoredValue({
      type: 'chat-message',
      storage: 'ref',
      refId: 'small-chat',
      preview: {
        kind: 'summary',
        label: 'Chat Message (function)',
        totalBytes: 12,
      },
    }),
    false,
  );
});

test('storeInputsOrOutputsForHistory skips absent port payloads', () => {
  const dataRefs = createDataRefStore();

  const stored = storeInputsOrOutputsForHistory(
    {
      present: { type: 'string', value: 'hello' },
      missing: undefined,
    } as never,
    dataRefs,
    {
      nodeId: 'node',
      processId: 'process',
      channel: 'output',
    },
  );

  assert.deepEqual(Object.keys(stored ?? {}), ['present']);
  assert.deepEqual(stored?.['present' as PortId], {
    type: 'string',
    storage: 'inline',
    value: 'hello',
  });
});

test('restoreStoredInputsOrOutputs ignores legacy nullish port payloads', () => {
  const dataRefs = createDataRefStore();

  const restored = restoreStoredInputsOrOutputs(
    {
      present: {
        type: 'string',
        storage: 'inline',
        value: 'hello',
      },
      missing: undefined,
    } as never,
    dataRefs,
  );

  assert.deepEqual(restored, {
    present: { type: 'string', value: 'hello' },
  });
});

test('restoreStoredDataValue tolerates malformed primitive legacy payloads', () => {
  const dataRefs = createDataRefStore();

  assert.doesNotThrow(() => restoreStoredDataValue(178 as never, dataRefs));
});

test('collectStoredRefIds collects input, output, and split-output refs from node run data', () => {
  const refIds = collectStoredRefIds({
    inputData: {
      input: {
        type: 'string',
        storage: 'ref',
        refId: 'input-ref',
        preview: {
          kind: 'text',
          excerpt: 'input',
          totalChars: 5,
          lineCount: 1,
        },
      },
    },
    outputData: {
      output: {
        type: 'object',
        storage: 'ref',
        refId: 'output-ref',
        preview: {
          kind: 'json',
          excerpt: '{}',
          totalChars: 2,
        },
      },
    },
    splitOutputData: {
      0: {
        split: {
          type: 'string',
          storage: 'ref',
          refId: 'split-ref',
          preview: {
            kind: 'text',
            excerpt: 'split',
            totalChars: 5,
            lineCount: 1,
          },
        },
      },
    },
  } as never);

  assert.deepEqual(refIds, ['input-ref', 'output-ref', 'split-ref']);
});

test('collectStoredRefIds tolerates legacy nullish split-output entries', () => {
  const refIds = collectStoredRefIds({
    splitOutputData: {
      0: undefined,
      1: {
        split: {
          type: 'string',
          storage: 'ref',
          refId: 'split-ref',
          preview: {
            kind: 'text',
            excerpt: 'split',
            totalChars: 5,
            lineCount: 1,
          },
        },
      },
    },
  } as never);

  assert.deepEqual(refIds, ['split-ref']);
});

test('collectStoredRefIds ignores malformed primitive port payloads', () => {
  const refIds = collectStoredRefIds({
    output: 178,
  } as never);

  assert.deepEqual(refIds, []);
});

test('collectStoredRefIds treats status-like port names as ordinary port maps', () => {
  const refIds = collectStoredRefIds({
    durationMs: {
      type: 'number',
      storage: 'ref',
      refId: 'duration-ms-port-ref',
      preview: {
        kind: 'summary',
        label: 'number',
      },
    },
    debugData: {
      type: 'object',
      storage: 'ref',
      refId: 'debug-data-port-ref',
      preview: {
        kind: 'json',
        excerpt: '{}',
        totalChars: 2,
      },
    },
    finishedAt: {
      type: 'number',
      storage: 'ref',
      refId: 'finished-at-port-ref',
      preview: {
        kind: 'summary',
        label: 'number',
      },
    },
    status: {
      type: 'string',
      storage: 'ref',
      refId: 'status-port-ref',
      preview: {
        kind: 'text',
        excerpt: 'status',
        totalChars: 6,
        lineCount: 1,
      },
    },
    inputData: {
      type: 'object',
      storage: 'ref',
      refId: 'input-data-port-ref',
      preview: {
        kind: 'json',
        excerpt: '{}',
        totalChars: 2,
      },
    },
    outputData: {
      type: 'object',
      storage: 'ref',
      refId: 'output-data-port-ref',
      preview: {
        kind: 'json',
        excerpt: '{}',
        totalChars: 2,
      },
    },
    splitOutputData: {
      type: 'object',
      storage: 'ref',
      refId: 'split-output-data-port-ref',
      preview: {
        kind: 'json',
        excerpt: '{}',
        totalChars: 2,
      },
    },
    startedAt: {
      type: 'number',
      storage: 'ref',
      refId: 'started-at-port-ref',
      preview: {
        kind: 'summary',
        label: 'number',
      },
    },
  } as never);

  assert.deepEqual(refIds, [
    'duration-ms-port-ref',
    'debug-data-port-ref',
    'finished-at-port-ref',
    'status-port-ref',
    'input-data-port-ref',
    'output-data-port-ref',
    'split-output-data-port-ref',
    'started-at-port-ref',
  ]);
});

test('collectStoredRefIds treats timing and status-only node run data as metadata', () => {
  const refIds = collectStoredRefIds({
    status: {
      type: 'error',
      error: 'boom',
    },
    startedAt: 1782343899251,
    finishedAt: 1782343899252,
    durationMs: 1,
  } as never);

  assert.deepEqual(refIds, []);
});

test('clearExecutionDataRefs tolerates metadata-only node run data', () => {
  const dataRefs = createDataRefStore();
  dataRefs.set('retained-ref', { type: 'string', value: 'retained' });

  assert.doesNotThrow(() => {
    clearExecutionDataRefs(dataRefs, {
      errorNode: [
        {
          processId: 'process-1' as never,
          data: {
            status: {
              type: 'error',
              error: 'boom',
            },
            finishedAt: 1782343899251,
            durationMs: 1,
          },
        },
      ],
    } as never);
  });
  assert.equal(dataRefs.values.has('retained-ref'), true);
});

test('storeDataValueForHistory stores large strings by ref and restores them losslessly', () => {
  const dataRefs = createDataRefStore();
  const value = { type: 'string', value: 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS + 100) } as const;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-1',
      processId: 'process-1',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.equal(stored.storage, 'ref');
  assert.equal(stored.refId, 'execution:node-1:process-1:output:output');
  assert.equal(stored.preview.kind, 'text');
  assert.equal(stored.preview.excerpt.endsWith('\n...'), true);
  assert.equal(dataRefs.values.get(stored.refId), value);
  assert.deepEqual(restoreStoredDataValue(stored, dataRefs), value);
});

test('storeDataValueForHistory marks large multi-line string previews as truncated when only the line limit is exceeded', () => {
  const dataRefs = createDataRefStore();
  const value = {
    type: 'string',
    value: Array.from({ length: 3000 }, (_, index) => `L${index}`).join('\n'),
  } as const;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-line-limit',
      processId: 'process-line-limit',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.equal(stored.storage, 'ref');
  assert.equal(stored.preview.kind, 'text');
  assert.equal(stored.preview.excerpt, 'L0\nL1\nL2\n...');
});

test('storeDataValueForHistory keeps smaller strings inline', () => {
  const dataRefs = createDataRefStore();
  const value = { type: 'string', value: 'small value' } as const;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-1',
      processId: 'process-1',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.deepEqual(stored, {
    type: 'string',
    storage: 'inline',
    value: 'small value',
  });
  assert.equal(dataRefs.values.size, 0);
});

test('storeDataValueForHistory keeps malformed string values inline without throwing', () => {
  const dataRefs = createDataRefStore();
  const value = { type: 'string', value: undefined } as unknown as DataValue;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-malformed-string',
      processId: 'process-malformed-string',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.deepEqual(stored, {
    type: 'string',
    storage: 'inline',
    value: undefined,
  });
  assert.equal(dataRefs.values.size, 0);
});

test('storeDataValueForHistory keeps malformed string arrays inline without throwing', () => {
  const dataRefs = createDataRefStore();
  const value = { type: 'string[]', value: undefined } as unknown as DataValue;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-malformed-string-array',
      processId: 'process-malformed-string-array',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.deepEqual(stored, {
    type: 'string[]',
    storage: 'inline',
    value: undefined,
  });
  assert.equal(dataRefs.values.size, 0);
});

test('storeDataValueForHistory keeps malformed media values inline without throwing', () => {
  const dataRefs = createDataRefStore();
  const value = { type: 'image', value: undefined } as unknown as DataValue;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-malformed-image',
      processId: 'process-malformed-image',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.deepEqual(stored, {
    type: 'image',
    storage: 'inline',
    value: undefined,
  });
  assert.equal(dataRefs.values.size, 0);
});

test('storeDataValueForHistory keeps malformed media arrays inline without throwing', () => {
  const dataRefs = createDataRefStore();
  const value = { type: 'binary[]', value: undefined } as unknown as DataValue;

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-malformed-binary-array',
      processId: 'process-malformed-binary-array',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.deepEqual(stored, {
    type: 'binary[]',
    storage: 'inline',
    value: undefined,
  });
  assert.equal(dataRefs.values.size, 0);
});

test('storeInputsOrOutputsForHistory stores large objects by ref with json preview', () => {
  const dataRefs = createDataRefStore();
  const objectValue = {
    type: 'object',
    value: Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`key-${index}`, `value-${index}-${'x'.repeat(64)}`]),
    ),
  } as const;

  const stored = storeInputsOrOutputsForHistory({ output: objectValue } as any, dataRefs, {
    nodeId: 'node-2',
    processId: 'process-2',
    channel: 'output',
  });

  assert.equal((stored as any)?.output.storage, 'ref');
  assert.equal((stored as any)?.output.preview.kind, 'json');
  assert.equal((stored as any)?.output.preview.excerpt.endsWith('\n...'), true);
  assert.deepEqual(restoreStoredInputsOrOutputs(stored, dataRefs), {
    output: objectValue,
  } as any);
});

test('storeDataValueForHistory keeps undefined items visible in large any-array previews', () => {
  const dataRefs = createDataRefStore();
  const value: DataValue = {
    type: 'any[]',
    value: [
      undefined,
      ...Array.from({ length: 400 }, (_, index) => ({ [`key-${index}`]: `value-${index}-${'x'.repeat(64)}` })),
    ],
  };

  const stored = storeDataValueForHistory(
    value,
    dataRefs,
    {
      nodeId: 'node-any-array',
      processId: 'process-any-array',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.equal(stored.storage, 'ref');
  assert.equal(stored.preview.kind, 'json');
  assert.match(stored.preview.excerpt, /"undefined"/);
  assert.doesNotMatch(stored.preview.excerpt, /^\[\n  null,/);
  assert.deepEqual(dataRefs.values.get(stored.refId), value);
  assert.equal((dataRefs.values.get(stored.refId) as Extract<DataValue, { type: 'any[]' }>).value[0], undefined);
  assert.deepEqual(restoreStoredDataValue(stored, dataRefs), value);
});

test('storeDataValueForHistory reuses stable ref ids for repeated writes to the same port', () => {
  const dataRefs = createDataRefStore();

  const first = storeDataValueForHistory(
    { type: 'string', value: 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1) },
    dataRefs,
    {
      nodeId: 'node-3',
      processId: 'process-3',
      channel: 'output',
    },
    'output' as PortId,
  );
  const second = storeDataValueForHistory(
    { type: 'string', value: 'b'.repeat(REF_STORAGE_THRESHOLD_CHARS + 2) },
    dataRefs,
    {
      nodeId: 'node-3',
      processId: 'process-3',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.equal(first.storage, 'ref');
  assert.equal(second.storage, 'ref');
  assert.equal(first.refId, second.refId);
  assert.equal(dataRefs.values.size, 1);
  assert.equal(dataRefs.values.get(first.refId)?.type, 'string');
  assert.equal((dataRefs.values.get(first.refId) as Extract<DataValue, { type: 'string' }>)?.value[0], 'b');
});

test('storeDataValueForHistory namespaces ref ids by project when provided', () => {
  const dataRefs = createDataRefStore();

  const first = storeDataValueForHistory(
    { type: 'string', value: 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1) },
    dataRefs,
    {
      nodeId: 'node-1',
      processId: 'process-1',
      projectId: 'project-a',
      channel: 'output',
    },
    'output' as PortId,
  );
  const second = storeDataValueForHistory(
    { type: 'string', value: 'b'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1) },
    dataRefs,
    {
      nodeId: 'node-1',
      processId: 'process-1',
      projectId: 'project-b',
      channel: 'output',
    },
    'output' as PortId,
  );

  assert.equal(first.storage, 'ref');
  assert.equal(second.storage, 'ref');
  assert.notEqual(first.refId, second.refId);
  assert.equal(dataRefs.values.get('execution:project-a:node-1:process-1:output:output')?.type, 'string');
  assert.equal(dataRefs.values.get('execution:project-b:node-1:process-1:output:output')?.type, 'string');
  assert.equal(
    (dataRefs.values.get('execution:project-a:node-1:process-1:output:output') as Extract<
      DataValue,
      { type: 'string' }
    >)?.value[0],
    'a',
  );
  assert.equal(
    (dataRefs.values.get('execution:project-b:node-1:process-1:output:output') as Extract<
      DataValue,
      { type: 'string' }
    >)?.value[0],
    'b',
  );
});

test('clearExecutionDataRefs removes all execution-scoped refs from previous run data', () => {
  const dataRefs = createDataRefStore();
  dataRefs.set('execution:node-4:process-4:output:output', {
    type: 'string',
    value: 'persisted',
  });

  clearExecutionDataRefs(dataRefs, {
    'node-4': [
      {
        processId: 'process-4' as any,
        data: {
          outputData: {
            output: {
              type: 'string',
              storage: 'ref',
              refId: 'execution:node-4:process-4:output:output',
              preview: {
                kind: 'text',
                excerpt: 'persisted',
                totalChars: 9,
                lineCount: 1,
              },
            },
          },
        },
      },
    ],
  } as any);

  assert.equal(dataRefs.values.size, 0);
});

test('splitRunDataByPreservedNodes separates previous run data for partial rerun resets', () => {
  const previousRunData = {
    a: [{ processId: 'process-a' as any, data: { status: { type: 'ok' } } }],
    b: [{ processId: 'process-b' as any, data: { status: { type: 'ok' } } }],
    c: [{ processId: 'process-c' as any, data: { status: { type: 'ok' } } }],
  } as any;

  const { preservedRunData, removedRunData } = splitRunDataByPreservedNodes(previousRunData, ['a', 'b'] as any);

  assert.deepEqual(Object.keys(preservedRunData), ['a', 'b']);
  assert.deepEqual(Object.keys(removedRunData), ['c']);
});

test('clearRemovedExecutionDataRefs leaves refs that are still used by preserved run data', () => {
  const dataRefs = createDataRefStore();
  dataRefs.set('preserved-ref', { type: 'string', value: 'preserved' });
  dataRefs.set('removed-ref', { type: 'string', value: 'removed' });
  dataRefs.set('shared-ref', { type: 'string', value: 'shared' });

  const preservedRunData = {
    a: [
      {
        processId: 'process-a' as any,
        data: {
          outputData: {
            output: {
              type: 'string',
              storage: 'ref',
              refId: 'preserved-ref',
              preview: {
                kind: 'text',
                excerpt: 'preserved',
                totalChars: 9,
                lineCount: 1,
              },
            },
            shared: {
              type: 'string',
              storage: 'ref',
              refId: 'shared-ref',
              preview: {
                kind: 'text',
                excerpt: 'shared',
                totalChars: 6,
                lineCount: 1,
              },
            },
          },
        },
      },
    ],
  } as any;
  const removedRunData = {
    c: [
      {
        processId: 'process-c' as any,
        data: {
          outputData: {
            output: {
              type: 'string',
              storage: 'ref',
              refId: 'removed-ref',
              preview: {
                kind: 'text',
                excerpt: 'removed',
                totalChars: 7,
                lineCount: 1,
              },
            },
            shared: {
              type: 'string',
              storage: 'ref',
              refId: 'shared-ref',
              preview: {
                kind: 'text',
                excerpt: 'shared',
                totalChars: 6,
                lineCount: 1,
              },
            },
          },
        },
      },
    ],
  } as any;

  clearRemovedExecutionDataRefs(dataRefs, removedRunData, preservedRunData);

  assert.equal(dataRefs.values.has('preserved-ref'), true);
  assert.equal(dataRefs.values.has('shared-ref'), true);
  assert.equal(dataRefs.values.has('removed-ref'), false);
});

test('hasUnavailableStoredRefs reports missing ref-backed values', () => {
  const dataRefs = createDataRefStore();
  const storedOutput = {
    outputData: {
      output: {
        type: 'string',
        storage: 'ref',
        refId: 'execution:node-ref:process-ref:output:output',
        preview: {
          kind: 'text',
          excerpt: 'cached',
          totalChars: 6,
          lineCount: 1,
        },
      },
    },
  } as any;

  assert.equal(hasUnavailableStoredRefs(storedOutput, dataRefs), true);

  dataRefs.set('execution:node-ref:process-ref:output:output', {
    type: 'string',
    value: 'cached',
  });

  assert.equal(hasUnavailableStoredRefs(storedOutput, dataRefs), false);
});

test('storeNodeDataForHistory omits undefined input and output fields so later updates do not clobber earlier run data', () => {
  const dataRefs = createDataRefStore();

  const stored = storeNodeDataForHistory(
    {
      status: { type: 'ok' },
      outputData: {
        output: {
          type: 'number',
          value: 42,
        },
      } as Outputs,
    },
    dataRefs,
    {
      nodeId: 'node-5',
      processId: 'process-5',
    },
  );

  assert.deepEqual(stored, {
    status: { type: 'ok' },
    outputData: {
      output: {
        type: 'number',
        storage: 'inline',
        value: 42,
      },
    },
  });
  assert.equal('inputData' in stored, false);
  assert.equal('splitOutputData' in stored, false);
});

test('storeNodeDataForHistory preserves explicit undefined duration so terminal events clear stale timing metadata', () => {
  const dataRefs = createDataRefStore();

  const stored = storeNodeDataForHistory(
    {
      status: { type: 'ok' },
      durationMs: undefined,
    },
    dataRefs,
    {
      nodeId: 'node-duration-clear',
      processId: 'process-duration-clear',
    },
  );

  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'durationMs'), true);
  assert.equal(stored.durationMs, undefined);
});

test('storeNodeDataForHistory preserves split-run item durations as transient metadata', () => {
  const dataRefs = createDataRefStore();

  const stored = storeNodeDataForHistory(
    {
      status: { type: 'ok' },
      durationMs: 20,
      splitRunDurationMs: { 0: 8, 1: 12 },
    },
    dataRefs,
    {
      nodeId: 'node-split-duration',
      processId: 'process-split-duration',
    },
  );

  assert.equal(stored.durationMs, 20);
  assert.deepEqual(stored.splitRunDurationMs, { 0: 8, 1: 12 });
});

test('storeNodeDataForHistory preserves node debug snapshots for later output rendering', () => {
  const dataRefs = createDataRefStore();

  const stored = storeNodeDataForHistory(
    {
      debugData: {
        expressionSource: '{{a}} * 2',
        extractObjectPathSource: '$.aaa["{{field}}"]',
        extractObjectPathUsePathInput: false,
      },
      status: { type: 'running' },
    },
    dataRefs,
    {
      nodeId: 'node-expression',
      processId: 'process-expression',
    },
  );

  assert.deepEqual(stored, {
    debugData: {
      expressionSource: '{{a}} * 2',
      extractObjectPathSource: '$.aaa["{{field}}"]',
      extractObjectPathUsePathInput: false,
    },
    status: { type: 'running' },
  });
});

test('storeNodeDataForHistory preserves interpolation input snapshots for parsed-source rendering', () => {
  const dataRefs = createDataRefStore();
  const largeInput = {
    type: 'string',
    value: `prefix ${'x'.repeat(REF_STORAGE_THRESHOLD_CHARS)}`,
  } as const;

  const stored = storeNodeDataForHistory(
    {
      debugData: {
        expressionSource: '{{value}}',
      },
      inputData: {
        value: largeInput,
      } as any,
      status: { type: 'ok' },
    },
    dataRefs,
    {
      nodeId: 'node-expression-inputs',
      processId: 'process-expression-inputs',
    },
  );

  assert.equal((stored.inputData as any).value.storage, 'ref');
  assert.deepEqual(restoreStoredInputsOrOutputs(stored.inputData as any, dataRefs), {
    value: largeInput,
  });
  assert.deepEqual(stored.debugData, {
    expressionSource: '{{value}}',
  });
});
