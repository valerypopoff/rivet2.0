import assert from 'node:assert/strict';
import test from 'node:test';
import { WarningsPort, type DataValue, type PortId } from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import type { NodeRunDataWithRefs } from '../state/dataFlow.js';
import {
  displayCopySections,
  projectStoredPortValueForCopy,
  projectDataValue,
  serializeDisplayedDataValue,
  serializeDisplayedPortValue,
  serializeDisplayedOutputs,
} from './executionDataCopyValue.js';

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

test('serializeDisplayedOutputs returns the plain value for a single string port', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('string', 'hello'),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, 'hello');
});

test('serializeDisplayedOutputs copies raw object JSON for a single object output', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('object', {
          key: 'Hello world!',
        }),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(
    serialized,
    JSON.stringify(
      {
        key: 'Hello world!',
      },
      null,
      2,
    ),
  );
});

test('serializeDisplayedOutputs does not treat real object values as copy metadata', () => {
  const objectValue = {
    kind: 'display-copy-sections',
    sections: [{ label: 'Looks like metadata', value: 'but is data' }],
  };
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('object', objectValue),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, JSON.stringify(objectValue, null, 2));
});

test('serializeDisplayedOutputs copies the visible missing-ref fallback for display copy', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: {
          type: 'object',
          storage: 'ref',
          refId: 'missing-output',
          preview: {
            kind: 'json',
            excerpt: '{}',
            totalChars: 2,
          },
        },
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, 'Value no longer available in memory.');
});

test('serializeDisplayedOutputs follows inferred preview semantics for any values', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('any', {
          key: 'Hello world!',
        }),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(
    serialized,
    JSON.stringify(
      {
        key: 'Hello world!',
      },
      null,
      2,
    ),
  );
});

test('serializeDisplayedOutputs copies explicit any undefined as visible text', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('any', undefined),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, 'undefined');
});

test('serializeDisplayedOutputs skips absent port wrappers without hiding explicit any undefined', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        missing: undefined,
        output: inlineStored('any', undefined),
      },
    } as never,
    createDataRefStore(),
  );

  assert.equal(serialized, 'undefined');
});

test('serializeDisplayedOutputs returns undefined when every visible port wrapper is absent', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: undefined,
      },
    } as never,
    createDataRefStore(),
  );

  assert.equal(serialized, undefined);
});

test('serializeDisplayedOutputs falls back to outputData when split outputs only contain absent wrappers', () => {
  const serialized = serializeDisplayedOutputs(
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

  assert.equal(serialized, 'visible fallback');
});

test('serializeDisplayedOutputs falls back to outputData when split outputs only contain hidden warning ports', () => {
  const serialized = serializeDisplayedOutputs(
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

  assert.equal(serialized, 'visible fallback');
});

test('serializeDisplayedOutputs falls back to custom outputData copy when split outputs only contain absent wrappers', () => {
  const serialized = serializeDisplayedOutputs(
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
    {
      getCopyValueData: ({ outputs, dataRefs }) => projectStoredPortValueForCopy(outputs, 'output' as PortId, dataRefs),
    },
  );

  assert.equal(serialized, 'visible fallback');
});

test('serializeDisplayedOutputs does not run custom copy projection for absent outputData wrappers', () => {
  let projectorCalls = 0;
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: undefined,
      },
    } as never,
    createDataRefStore(),
    {
      getCopyValueData: () => {
        projectorCalls += 1;
        return 'phantom';
      },
    },
  );

  assert.equal(serialized, undefined);
  assert.equal(projectorCalls, 0);
});

test('projectStoredPortValueForCopy preserves explicit any undefined but skips absent wrappers', () => {
  const outputs = {
    missing: undefined,
    output: inlineStored('any', undefined),
  } as never;
  const dataRefs = createDataRefStore();

  assert.equal(projectStoredPortValueForCopy(outputs, 'missing' as PortId, dataRefs), undefined);
  assert.equal(projectStoredPortValueForCopy(outputs, 'output' as PortId, dataRefs), 'undefined');
});

test('serializeDisplayedPortValue copies one output without labelled section text', () => {
  const outputs = {
    first: inlineStored('string', 'first value'),
    second: inlineStored('object', { key: 'second value' }),
  } as never;
  const dataRefs = createDataRefStore();

  assert.equal(serializeDisplayedPortValue(outputs, 'first' as PortId, dataRefs), 'first value');
  assert.equal(serializeDisplayedPortValue(outputs, 'second' as PortId, dataRefs), '{\n  "key": "second value"\n}');
});

test('serializeDisplayedDataValue matches visible display-copy fallbacks for structured sections', () => {
  assert.equal(serializeDisplayedDataValue(inlineStored('any', undefined), createDataRefStore()), 'undefined');
  assert.equal(
    serializeDisplayedDataValue(
      {
        type: 'object',
        storage: 'ref',
        refId: 'missing-output',
        preview: {
          kind: 'json',
          excerpt: '{}',
          totalChars: 2,
        },
      },
      createDataRefStore(),
    ),
    'Value no longer available in memory.',
  );
});

test('serializeDisplayedOutputs preserves explicit any undefined in multi-port output text', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('any', undefined),
        fallback: inlineStored('string', 'next value'),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, ['output', 'undefined', '', 'fallback', 'next value'].join('\n'));
});

test('serializeDisplayedOutputs copies undefined items in explicit any arrays as visible text', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('any[]', [{ key: 'value' }, undefined, null]),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(
    serialized,
    JSON.stringify(
      [
        {
          key: 'value',
        },
        'undefined',
        null,
      ],
      null,
      2,
    ),
  );
});

test('serializeDisplayedOutputs copies inferred any arrays with undefined items as visible text', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('any', [undefined, 'next value']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, JSON.stringify(['undefined', 'next value'], null, 2));
});

test('projectDataValue preserves circular any arrays without recursive expansion', () => {
  const value: unknown[] = [undefined];
  value.push(value);

  const projected = projectDataValue({ type: 'any[]', value });

  assert.equal(Array.isArray(projected), true);
  assert.equal((projected as unknown[])[0], 'undefined');
  assert.equal((projected as unknown[])[1], projected);
});

test('projectDataValue preserves array return types in deferred value labels', () => {
  assert.equal(projectDataValue({ type: 'fn<string[]>', value: () => ['value'] }), 'Function<string[]>');
});

test('serializeDisplayedOutputs tolerates circular projected values', () => {
  const value: unknown[] = [undefined];
  value.push(value);
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('any[]', value),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(typeof serialized, 'string');
});

test('serializeDisplayedOutputs copies raw arrays without DataValue wrappers', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('string[]', ['one', 'two']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, JSON.stringify(['one', 'two'], null, 2));
});

test('serializeDisplayedOutputs matches the preview text for control-flow-excluded values', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('control-flow-excluded', undefined),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, 'Not ran');
});

test('serializeDisplayedOutputs keeps chat-message flattening semantics', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('chat-message', {
          type: 'assistant',
          message: ['Hello', { type: 'url', url: 'https://example.com' }],
          function_call: undefined,
          function_calls: undefined,
        }),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, 'Hello\n\nhttps://example.com');
});

test('serializeDisplayedOutputs tolerates malformed preview-only output payloads', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        messages: inlineStored(
          'chat-message[]',
          undefined as unknown as Extract<DataValue, { type: 'chat-message[]' }>['value'],
        ),
        vector: inlineStored('vector', undefined as unknown as number[]),
        binary: inlineStored('binary', undefined as unknown as Uint8Array),
        document: inlineStored('document', undefined as unknown as Extract<DataValue, { type: 'document' }>['value']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(
    serialized,
    [
      'messages',
      '[]',
      '',
      'vector',
      'Vector (length 0)',
      '',
      'binary',
      'Binary (length 0)',
      '',
      'document',
      'Document (unknown media type)\nSize: 0 bytes',
    ].join('\n'),
  );
});

test('serializeDisplayedOutputs excludes warnings from visible labelled sections', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('object', { key: 'value' }),
        details: inlineStored('string[]', ['a', 'b']),
        [WarningsPort]: inlineStored('string[]', ['warning']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(
    serialized,
    ['output', JSON.stringify({ key: 'value' }, null, 2), '', 'details', JSON.stringify(['a', 'b'], null, 2)].join(
      '\n',
    ),
  );
});

test('serializeDisplayedOutputs copies multi-port outputs as visible labelled sections', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        statusCode: inlineStored('number', 403),
        res_headers: inlineStored('object', { 'content-type': 'application/json' }),
        [WarningsPort]: inlineStored('string[]', ['warning']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      outputDefinitions: [
        { id: 'statusCode' as PortId, title: 'Status Code' },
        { id: 'res_headers' as PortId, title: 'Headers' },
      ],
    },
  );

  assert.equal(
    serialized,
    ['Status Code', '403', '', 'Headers', JSON.stringify({ 'content-type': 'application/json' }, null, 2)].join('\n'),
  );
});

test('serializeDisplayedOutputs serializes split outputs as visible values and preserves index ordering', () => {
  const serialized = serializeDisplayedOutputs(
    {
      splitOutputData: {
        1: {
          output: inlineStored('object', {
            second: true,
          }),
        },
        0: {
          output: inlineStored('string', 'first'),
        },
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
  );

  assert.equal(serialized, ['first', '', JSON.stringify({ second: true }, null, 2)].join('\n'));
});

test('serializeDisplayedOutputs serializes split custom sections without leaking copy metadata', () => {
  const serialized = serializeDisplayedOutputs(
    {
      splitOutputData: {
        1: {
          output: inlineStored('string', 'ignored'),
        },
        0: {
          output: inlineStored('string', 'ignored'),
        },
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: () => displayCopySections([{ label: 'Projected', value: 'visible' }]),
    },
  );

  assert.equal(serialized, ['Projected', 'visible', '', 'Projected', 'visible'].join('\n'));
});

test('serializeDisplayedOutputs skips hidden split maps before custom copy projection', () => {
  const projectedSplits: string[] = [];
  const serialized = serializeDisplayedOutputs(
    {
      splitOutputData: {
        0: {
          output: undefined,
        },
        1: {
          output: inlineStored('string', 'visible'),
        },
        2: {
          [WarningsPort]: inlineStored('string[]', ['warning']),
        },
      },
    } as never,
    createDataRefStore(),
    {
      getCopyValueData: ({ outputs }) => {
        projectedSplits.push(Object.keys(outputs).join(','));
        return displayCopySections([{ label: 'Projected', value: 'visible' }]);
      },
    },
  );

  assert.equal(serialized, ['Projected', 'visible'].join('\n'));
  assert.deepEqual(projectedSplits, ['output']);
});
