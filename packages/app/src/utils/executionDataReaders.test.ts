import assert from 'node:assert/strict';
import test from 'node:test';
import { WarningsPort, type DataValue } from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import type { NodeRunDataWithRefs } from '../state/dataFlow.js';
import {
  coerceStoredPortValue,
  getStoredOutputWarnings,
  hasStoredPortMapValues,
  hasStoredSplitOutputValues,
  restoreDisplayedNodeOutputs,
  restoreStoredPortValue,
  tryRestoreStoredPortMap,
} from './executionDataReaders.js';

function createDataRefStore(initialValues?: Record<string, DataValue>): DataRefReader {
  const values = new Map<string, DataValue>(Object.entries(initialValues ?? {}));
  return {
    get: (key) => values.get(key),
  };
}

function inlineStored<T extends DataValue['type']>(type: T, value: Extract<DataValue, { type: T }>['value']) {
  return {
    type,
    storage: 'inline' as const,
    value,
  };
}

function refStored<T extends DataValue['type']>(type: T, refId: string) {
  return {
    type,
    storage: 'ref' as const,
    refId,
    preview: {
      kind: 'json' as const,
      excerpt: '{}',
      totalChars: 2,
    },
  };
}

test('restoreDisplayedNodeOutputs keeps wrapped values for the copy-as-json path', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      outputData: {
        output: inlineStored('object', {
          key: 'Hello world!',
        }),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    output: {
      type: 'object',
      value: {
        key: 'Hello world!',
      },
    },
  });
});

test('restoreDisplayedNodeOutputs skips absent port wrappers', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      outputData: {
        missing: undefined,
        output: inlineStored('any', undefined),
      },
    } as never,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    output: {
      type: 'any',
      value: undefined,
    },
  });
});

test('restoreDisplayedNodeOutputs returns undefined when every visible port wrapper is absent', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      outputData: {
        output: undefined,
      },
    } as never,
    createDataRefStore(),
  );

  assert.equal(restored, undefined);
});

test('restoreDisplayedNodeOutputs prefers split outputs when they are present', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      outputData: {
        output: inlineStored('string', 'ignored'),
      },
      splitOutputData: {
        0: {
          output: inlineStored('string', 'visible'),
        },
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    0: {
      output: {
        type: 'string',
        value: 'visible',
      },
    },
  });
});

test('restoreDisplayedNodeOutputs skips empty split output maps', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      splitOutputData: {
        0: {
          output: undefined,
        },
        1: {
          output: inlineStored('string', 'visible'),
        },
      },
    } as never,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    1: {
      output: {
        type: 'string',
        value: 'visible',
      },
    },
  });
});

test('restoreDisplayedNodeOutputs falls back to outputData when split outputs only contain absent wrappers', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      outputData: {
        output: inlineStored('string', 'visible fallback'),
      },
      splitOutputData: {
        0: {
          output: undefined,
        },
      },
    } as never,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    output: {
      type: 'string',
      value: 'visible fallback',
    },
  });
});

test('restoreDisplayedNodeOutputs falls back to outputData when split outputs only contain hidden warning ports', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      outputData: {
        output: inlineStored('string', 'visible fallback'),
      },
      splitOutputData: {
        0: {
          [WarningsPort]: inlineStored('string[]', ['warning']),
        },
      },
    } as never,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    output: {
      type: 'string',
      value: 'visible fallback',
    },
  });
});

test('restoreDisplayedNodeOutputs restores hidden split outputs when no outputData fallback exists', () => {
  const restored = restoreDisplayedNodeOutputs(
    {
      splitOutputData: {
        0: {
          [WarningsPort]: inlineStored('string[]', ['warning']),
        },
      },
    } as never,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    0: {
      [WarningsPort]: {
        type: 'string[]',
        value: ['warning'],
      },
    },
  });
});

test('getStoredOutputWarnings aggregates warnings from split outputs', () => {
  const warnings = getStoredOutputWarnings(
    {
      splitOutputData: {
        0: {
          [WarningsPort]: inlineStored('string[]', ['first warning']),
        },
        1: {
          [WarningsPort]: inlineStored('string[]', ['second warning', 'first warning']),
        },
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.deepEqual(warnings, ['first warning', 'second warning']);
});

test('restoreStoredPortValue returns undefined for a missing port', () => {
  const restored = restoreStoredPortValue(undefined, 'missing' as never, createDataRefStore());

  assert.equal(restored, undefined);
});

test('hasStoredPortMapValues distinguishes real port wrappers from absent wrappers', () => {
  assert.equal(
    hasStoredPortMapValues({
      output: undefined,
    } as never),
    false,
  );
  assert.equal(
    hasStoredPortMapValues({
      output: inlineStored('any', undefined),
    } as never),
    true,
  );
});

test('hasStoredSplitOutputValues distinguishes real split wrappers from empty split maps', () => {
  assert.equal(
    hasStoredSplitOutputValues({
      0: undefined,
      1: null,
    } as never),
    false,
  );
  assert.equal(
    hasStoredSplitOutputValues({
      0: {
        output: undefined,
      },
    } as never),
    false,
  );
  assert.equal(
    hasStoredSplitOutputValues({
      0: {
        output: inlineStored('string', 'visible'),
      },
    } as never),
    true,
  );
});

test('tryRestoreStoredPortMap skips unavailable ref-backed values without losing available ports', () => {
  const restored = tryRestoreStoredPortMap(
    {
      output: inlineStored('string', 'available'),
      missing: refStored('object', 'missing-ref'),
    } as never,
    createDataRefStore(),
  );

  assert.deepEqual(restored, {
    output: {
      type: 'string',
      value: 'available',
    },
  });
});

test('tryRestoreStoredPortMap returns undefined when no ports can be restored', () => {
  const restored = tryRestoreStoredPortMap(
    {
      missing: refStored('object', 'missing-ref'),
    } as never,
    createDataRefStore(),
  );

  assert.equal(restored, undefined);
});

test('coerceStoredPortValue returns undefined safely for a missing port', () => {
  const restored = coerceStoredPortValue(undefined, 'missing' as never, 'number', createDataRefStore());

  assert.equal(restored, undefined);
});
