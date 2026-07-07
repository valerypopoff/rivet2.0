import assert from 'node:assert/strict';
import test from 'node:test';
import { WarningsPort, type DataValue } from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../providers/ProvidersContext.js';
import type { NodeRunDataWithRefs } from '../state/dataFlow.js';
import { serializeDisplayedOutputs } from './executionDataCopyValue.js';
import {
  getChatNodeCopyValueData,
  getLoopControllerNodeCopyValueData,
  getSubGraphNodeCopyValueData,
  getUserInputNodeCopyValueData,
} from './nodeOutputCopyValueProjectors.js';

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

test('chat copy-value projector returns plain response text when only the response is visible', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: inlineStored('string', 'Hello world!'),
        ['in-messages']: inlineStored('chat-message[]', []),
        ['all-messages']: inlineStored('chat-message[]', []),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(serialized, 'Hello world!');
});

test('chat copy-value projector still runs when the process has error status and visible outputs', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: inlineStored('string', 'Partial response'),
      },
      status: { type: 'error', error: 'Tool call failed' },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(serialized, 'Partial response');
});

test('chat copy-value projector preserves missing response fallback text', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: refStored('string', 'missing-response'),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(serialized, 'Value no longer available in memory.');
});

test('chat copy-value projector skips absent response wrappers', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: undefined,
      },
    } as never,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(serialized, undefined);
});

test('chat copy-value projector copies only the visible response, function call, and visible meta fields', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: inlineStored('string', 'Hello world!'),
        ['function-call']: inlineStored('object', {
          name: 'lookup',
          arguments: {
            key: 'value',
          },
        }),
        requestTokens: inlineStored('number', 10),
        responseTokens: inlineStored('number', 12),
        cost: inlineStored('number', 0.123),
        duration: inlineStored('number', 250),
        ['in-messages']: inlineStored('chat-message[]', [
          {
            type: 'user',
            message: 'ignored',
          },
        ]),
        usage: inlineStored('object', {
          hidden: true,
        }),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(
    serialized,
    [
      'Response',
      'Hello world!',
      '',
      'Function Call',
      JSON.stringify(
        {
          name: 'lookup',
          arguments: {
            key: 'value',
          },
        },
        null,
        2,
      ),
      '',
      'Request Tokens',
      '10',
      '',
      'Response Tokens',
      '12',
      '',
      'Cost',
      '$0.123',
      '',
      'Duration',
      '250ms',
    ].join('\n'),
  );
});

test('chat copy-value projector does not include duration when the chat UI would hide the meta block', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: inlineStored('string', 'Hello world!'),
        duration: inlineStored('number', 250),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(serialized, 'Hello world!');
});

test('chat copy-value projector includes duration when a visible meta carrier exists even if the carrier value itself is hidden', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        response: inlineStored('string', 'Hello world!'),
        requestTokens: inlineStored('number', 0),
        duration: inlineStored('number', 250),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getChatNodeCopyValueData,
    },
  );

  assert.equal(serialized, ['Response', 'Hello world!', '', 'Duration', '250ms'].join('\n'));
});

test('user input copy-value projector only copies questionsAndAnswers', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output: inlineStored('string[]', ['answer']),
        questionsAndAnswers: inlineStored('string[]', ['What?\nanswer']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getUserInputNodeCopyValueData,
    },
  );

  assert.equal(serialized, JSON.stringify(['What?\nanswer'], null, 2));
});

test('user input copy-value projector returns nothing when the output preview is empty', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        questionsAndAnswers: inlineStored('control-flow-excluded', undefined),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getUserInputNodeCopyValueData,
    },
  );

  assert.equal(serialized, undefined);
});

test('loop controller copy-value projector excludes break and iteration and copies visible labels', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        break: inlineStored('any[]', ['done']),
        iteration: inlineStored('number', 2),
        output1: inlineStored('string', 'next'),
        output2: inlineStored('control-flow-excluded', undefined),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getLoopControllerNodeCopyValueData,
    },
  );

  assert.equal(serialized, ['Continue', 'false', '', 'Output 1', 'next', '', 'Output 2', 'Not ran'].join('\n'));
});

test('loop controller copy-value projector skips absent output wrappers', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        output1: inlineStored('string', 'next'),
        output2: undefined,
      },
    } as never,
    createDataRefStore(),
    {
      getCopyValueData: getLoopControllerNodeCopyValueData,
    },
  );

  assert.equal(serialized, ['Continue', 'true', '', 'Output 1', 'next'].join('\n'));
});

test('subgraph copy-value projector includes visible meta and visible outputs only', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        cost: inlineStored('number', 0.5),
        duration: inlineStored('number', 125),
        result: inlineStored('object', {
          ok: true,
        }),
        [WarningsPort]: inlineStored('string[]', ['warning']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getSubGraphNodeCopyValueData,
    },
  );

  assert.equal(
    serialized,
    ['Cost', '$0.500', '', 'Duration', '125ms', '', 'result', JSON.stringify({ ok: true }, null, 2)].join('\n'),
  );
});

test('subgraph copy-value projector copies multiple body outputs as visible labels without meta', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        first: inlineStored('string', 'one'),
        second: inlineStored('object', {
          two: true,
        }),
        [WarningsPort]: inlineStored('string[]', ['warning']),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getSubGraphNodeCopyValueData,
    },
  );

  assert.equal(serialized, ['first', 'one', '', 'second', JSON.stringify({ two: true }, null, 2)].join('\n'));
});

test('subgraph copy-value projector preserves missing body-output fallback text', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        first: refStored('object', 'missing-subgraph-output'),
        second: inlineStored('string', 'two'),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getSubGraphNodeCopyValueData,
    },
  );

  assert.equal(serialized, ['first', 'Value no longer available in memory.', '', 'second', 'two'].join('\n'));
});

test('subgraph copy-value projector skips absent body-output wrappers', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        first: undefined,
        second: inlineStored('string', 'two'),
      },
    } as never,
    createDataRefStore(),
    {
      getCopyValueData: getSubGraphNodeCopyValueData,
    },
  );

  assert.equal(serialized, 'two');
});

test('subgraph copy-value projector includes split metric meta that the UI renders', () => {
  const serialized = serializeDisplayedOutputs(
    {
      outputData: {
        cost: inlineStored('number[]', [0.5, 0.25]),
        duration: inlineStored('number[]', [125, 250]),
        result: inlineStored('string', 'ok'),
      },
    } as NodeRunDataWithRefs,
    createDataRefStore(),
    {
      getCopyValueData: getSubGraphNodeCopyValueData,
    },
  );

  assert.equal(
    serialized,
    [
      'Cost',
      'Total cost: $0.750\nRun 1: $0.500\nRun 2: $0.250',
      '',
      'Duration',
      'Total duration: 375ms\nRun 1: 125ms\nRun 2: 250ms',
      '',
      'result',
      'ok',
    ].join('\n'),
  );
});
