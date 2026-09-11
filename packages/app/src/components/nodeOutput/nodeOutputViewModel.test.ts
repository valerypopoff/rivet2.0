import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WarningsPort,
  type DataValue,
  type GraphId,
  type GraphRunId,
  type PortId,
  type ProcessId,
  type RootRunId,
} from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../../providers/ProvidersContext.js';
import type { NodeRunDataWithRefs, ProcessDataForNode } from '../../state/dataFlow.js';
import { filterProcessDataForSelection } from '../../state/selectors/executionSelectors.js';
import {
  createFullscreenNodeOutputViewModel,
  createNodeOutputBodyViewModel,
  createNodeOutputContentViewModel,
  createNodeOutputSectionsViewModel,
  getNodeOutputCopySource,
  serializeNodeOutputDisplayCopy,
  serializeNodeOutputJsonCopy,
} from './nodeOutputViewModel.js';
import { getStopWatchingStreamingOutputPresentation } from './streamingOutputWatchPresentation.js';

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

function process(processId: string, data: NodeRunDataWithRefs): ProcessDataForNode {
  return {
    processId: processId as ProcessId,
    data,
  };
}

test('Stop Watching Streaming Output presents the accepted terminal instead of the latest parallel completion', () => {
  const processes = [
    process('losing-late', {
      outputData: { ['value' as PortId]: inlineStored('string', 'late loser') },
      status: { type: 'ok' },
    }),
    process('accepted', {
      outputData: { ['value' as PortId]: inlineStored('string', 'accepted winner') },
      status: { type: 'ok' },
      streamingWatchTerminal: true,
    }),
  ];

  assert.deepEqual(getStopWatchingStreamingOutputPresentation(processes), [processes[1]]);
});

test('Stop Watching Streaming Output keeps older recordings readable without a terminal marker', () => {
  const processes = [
    process('first', { status: { type: 'ok' } }),
    process('last', { status: { type: 'ok' } }),
  ];

  assert.deepEqual(getStopWatchingStreamingOutputPresentation(processes), [processes[1]]);
});

test('createNodeOutputContentViewModel keeps legacy Code errors on the code-error path', () => {
  const data = { status: { type: 'error', error: 'SyntaxError' } } as const;
  const content = createNodeOutputContentViewModel({
    nodeType: 'code',
    data,
    dataRefs: createDataRefStore(),
  });

  assert.equal(content.kind, 'code-error');
  assert.equal(content.contentKeyKind, 'code-error');
});

test('createNodeOutputContentViewModel keeps Code/Expression-family errors on their custom output path', () => {
  const data = { status: { type: 'error', error: 'SyntaxError' } } as const;
  const content = createNodeOutputContentViewModel({
    nodeType: 'codeNew',
    data,
    dataRefs: createDataRefStore(),
  });

  assert.equal(content.kind, 'custom-error');
  assert.equal(content.contentKeyKind, 'custom-error');
});

test('createNodeOutputContentViewModel keeps generic node errors on the generic error path', () => {
  const content = createNodeOutputContentViewModel({
    nodeType: 'text',
    data: { status: { type: 'error', error: 'Failed' } },
    dataRefs: createDataRefStore(),
  });

  assert.equal(content.kind, 'generic-error');
  assert.equal(content.error, 'Failed');
  assert.equal(serializeNodeOutputDisplayCopy(getNodeOutputCopySource(content), createDataRefStore()), 'Failed');
  assert.equal(serializeNodeOutputJsonCopy(getNodeOutputCopySource(content), createDataRefStore()), undefined);
});

test('createNodeOutputContentViewModel treats generic errors with stored outputs as additive output content', () => {
  const data = {
    outputData: {
      ['output' as PortId]: inlineStored('string', 'hello'),
    },
    status: { type: 'error', error: 'Failed' },
  } as NodeRunDataWithRefs;
  const content = createNodeOutputContentViewModel({
    nodeType: 'text',
    data,
    dataRefs: createDataRefStore(),
  });
  const copySource = getNodeOutputCopySource(content);

  assert.equal(content.kind, 'output');
  assert.equal(content.kind === 'output' ? content.errorMessage : undefined, 'Failed');
  assert.equal(serializeNodeOutputDisplayCopy(copySource, createDataRefStore()), 'Error\nFailed\n\nhello');
  assert.equal(
    serializeNodeOutputJsonCopy(copySource, createDataRefStore()),
    JSON.stringify(
      {
        output: {
          type: 'string',
          value: 'hello',
        },
      },
      null,
      2,
    ),
  );
});

test('createNodeOutputContentViewModel preserves split outputs when a run ends with an error', () => {
  const content = createNodeOutputContentViewModel({
    nodeType: 'text',
    data: {
      splitOutputData: {
        0: {
          ['output' as PortId]: inlineStored('string', 'first'),
        },
        1: {
          ['output' as PortId]: inlineStored('string', 'second'),
        },
      },
      status: { type: 'error', error: 'Split failed' },
    } as NodeRunDataWithRefs,
    dataRefs: createDataRefStore(),
  });

  assert.equal(content.kind, 'output');
  assert.equal(content.kind === 'output' ? content.errorMessage : undefined, 'Split failed');
  assert.equal(
    serializeNodeOutputDisplayCopy(getNodeOutputCopySource(content), createDataRefStore()),
    'Error\nSplit failed\n\nfirst\n\nsecond',
  );
});

test('createNodeOutputContentViewModel keeps custom errors copyable with and without stored outputs', () => {
  const errorOnlyContent = createNodeOutputContentViewModel({
    nodeType: 'codeNew',
    data: { status: { type: 'error', error: 'SyntaxError' } },
    dataRefs: createDataRefStore(),
  });
  const mixedContent = createNodeOutputContentViewModel({
    nodeType: 'codeNew',
    data: {
      outputData: {
        ['output' as PortId]: inlineStored('string', 'value'),
      },
      status: { type: 'error', error: 'SyntaxError' },
    },
    dataRefs: createDataRefStore(),
  });

  assert.equal(errorOnlyContent.kind, 'custom-error');
  assert.equal(serializeNodeOutputDisplayCopy(getNodeOutputCopySource(errorOnlyContent), createDataRefStore()), 'SyntaxError');
  assert.equal(mixedContent.kind, 'custom-error');
  assert.equal(serializeNodeOutputDisplayCopy(getNodeOutputCopySource(mixedContent), createDataRefStore()), 'Error\nSyntaxError\n\nvalue');
});

test('createNodeOutputContentViewModel exposes warnings separately from body output ports', () => {
  const content = createNodeOutputContentViewModel({
    nodeType: 'text',
    data: {
      outputData: {
        ['output' as PortId]: inlineStored('string', 'hello'),
        [WarningsPort as PortId]: inlineStored('string[]', ['Careful']),
      },
      status: { type: 'ok' },
    },
    dataRefs: createDataRefStore(),
  });

  assert.equal(content.kind, 'output');
  assert.deepEqual(content.kind === 'output' ? content.warnings : undefined, ['Careful']);
  assert.equal(getNodeOutputCopySource(content), content.kind === 'output' ? content.copySource : undefined);
});

test('createNodeOutputContentViewModel treats hidden-only and absent output maps as empty', () => {
  assert.equal(
    createNodeOutputContentViewModel({
      nodeType: 'text',
      data: {
        outputData: {
          ['output' as PortId]: undefined,
        },
        status: { type: 'ok' },
      } as never,
      dataRefs: createDataRefStore(),
    }).kind,
    'empty',
  );

  assert.equal(
    createNodeOutputContentViewModel({
      nodeType: 'text',
      data: {
        outputData: {
          ['__internalPort_private' as PortId]: inlineStored('string', 'hidden'),
        },
        status: { type: 'ok' },
      } as never,
      dataRefs: createDataRefStore(),
    }).kind,
    'empty',
  );
});

test('createNodeOutputContentViewModel exposes duration-only output only when enabled', () => {
  const data = {
    durationMs: 15,
    status: { type: 'ok' },
  } as NodeRunDataWithRefs;

  assert.equal(
    createNodeOutputContentViewModel({
      nodeType: 'text',
      data,
      dataRefs: createDataRefStore(),
    }).kind,
    'empty',
  );

  const content = createNodeOutputContentViewModel({
    nodeType: 'text',
    data,
    dataRefs: createDataRefStore(),
    showNodeRunDuration: true,
  });

  assert.equal(content.kind, 'output');
  assert.equal(serializeNodeOutputDisplayCopy(getNodeOutputCopySource(content), createDataRefStore()), undefined);
});

test('renders a retained Watch Stop Value in both inline and fullscreen output models', () => {
  const graphId = 'watch-graph' as GraphId;
  const rootRunId = 'root-run' as RootRunId;
  const parentGraphRunId = 'parent-run' as GraphRunId;
  const retainedStopProcess: ProcessDataForNode = {
    processId: 'stop-child-process' as ProcessId,
    graphId,
    graphRunId: 'watch-child-run' as GraphRunId,
    parentGraphRunId,
    rootRunId,
    data: {
      outputData: {
        ['value' as PortId]: inlineStored('string', 'accepted chunk'),
      },
      status: { type: 'ok' },
    },
  };
  const retainedProcesses = filterProcessDataForSelection({
    graphRuns: [{ graphId, graphRunId: parentGraphRunId, rootRunId }],
    processData: [retainedStopProcess],
    selectedGraphRun: parentGraphRunId,
  });

  assert.deepEqual(retainedProcesses, [retainedStopProcess]);

  // The inline node body and fullscreen modal both use these shared output
  // view models after graph-run filtering. Keep the Stop boundary's ordinary
  // Value port visible in each instead of treating its child-run identity as
  // a reason to hide an output that already feeds normal downstream work.
  const inlineContent = createNodeOutputContentViewModel({
    nodeType: 'stopWatchingStreamingOutput',
    data: retainedStopProcess.data,
    dataRefs: createDataRefStore(),
  });
  const inlineBody = createNodeOutputBodyViewModel({ data: retainedStopProcess.data });
  const fullscreen = createFullscreenNodeOutputViewModel({
    nodeType: 'stopWatchingStreamingOutput',
    processData: retainedProcesses,
    selectedPage: 'latest',
    dataRefs: createDataRefStore(),
  });

  assert.equal(inlineContent.kind, 'output');
  assert.equal(inlineBody.kind, 'outputs');
  assert.equal(fullscreen.kind, 'content');
  assert.equal(
    serializeNodeOutputDisplayCopy(getNodeOutputCopySource(inlineContent), createDataRefStore(), {
      outputDefinitions: [{ id: 'value' as PortId, title: 'Value' }],
    }),
    'accepted chunk',
  );
});

test('createNodeOutputBodyViewModel chooses custom renderers before generic output maps', () => {
  const data = {
    outputData: {
      ['output' as PortId]: inlineStored('string', 'hello'),
    },
  } as NodeRunDataWithRefs;

  assert.equal(
    createNodeOutputBodyViewModel({ data, hasFullscreenOutputRenderer: true }).kind,
    'custom-fullscreen-renderer',
  );
  assert.equal(createNodeOutputBodyViewModel({ data, hasOutputRenderer: true }).kind, 'custom-renderer');
});

test('createNodeOutputBodyViewModel ignores final output maps with no visible body ports', () => {
  const body = createNodeOutputBodyViewModel({
    data: {
      outputData: {
        [WarningsPort as PortId]: inlineStored('string[]', ['warning']),
        ['__internalPort_private' as PortId]: inlineStored('string', 'hidden'),
      },
    } as never,
  });

  assert.equal(body.kind, 'empty');
});

test('createNodeOutputBodyViewModel sorts visible split outputs and skips hidden-only entries', () => {
  const body = createNodeOutputBodyViewModel({
    data: {
      splitOutputData: {
        10: {
          ['output' as PortId]: inlineStored('string', 'ten'),
        },
        1: {
          ['output' as PortId]: undefined,
        },
        2: {
          [WarningsPort as PortId]: inlineStored('string[]', ['warning']),
        },
        0: {
          ['output' as PortId]: inlineStored('string', 'zero'),
        },
      },
    } as never,
  });

  assert.equal(body.kind, 'split-outputs');
  assert.deepEqual(
    body.kind === 'split-outputs' ? body.splitOutputs.map(([key]) => key) : [],
    ['0', '10'],
  );
});

test('createNodeOutputBodyViewModel falls back to final outputData when split outputs are not body-renderable', () => {
  const body = createNodeOutputBodyViewModel({
    data: {
      outputData: {
        ['output' as PortId]: inlineStored('string', 'final'),
      },
      splitOutputData: {
        0: {
          [WarningsPort as PortId]: inlineStored('string[]', ['warning']),
        },
      },
    } as never,
  });

  assert.equal(body.kind, 'outputs');
});

test('createNodeOutputSectionsViewModel keeps single regular outputs headerless', () => {
  const outputValue = inlineStored('string', 'single');
  const sections = createNodeOutputSectionsViewModel({
    definitions: [{ id: 'output' as PortId, title: 'Result' }],
    outputs: {
      ['output' as PortId]: outputValue,
    },
    isCompact: false,
  });

  assert.deepEqual(sections, [
    {
      headerMode: 'hidden',
      label: 'Result',
      portId: 'output',
      value: outputValue,
    },
  ]);
});

test('createNodeOutputSectionsViewModel gives large single outputs a fallback Output label', () => {
  const outputValue = inlineStored('string', 'single');
  const sections = createNodeOutputSectionsViewModel({
    outputs: {
      ['output' as PortId]: outputValue,
    },
    isCompact: false,
    showLargeHeaders: true,
  });

  assert.deepEqual(sections, [
    {
      headerMode: 'large',
      label: 'Output',
      portId: 'output',
      value: outputValue,
    },
  ]);
});

test('createNodeOutputSectionsViewModel labels multiple outputs and preserves port order', () => {
  const firstValue = inlineStored('string', 'first');
  const secondValue = inlineStored('string', 'second');
  const sections = createNodeOutputSectionsViewModel({
    definitions: [
      { id: 'first' as PortId, title: 'First title' },
      { id: 'second' as PortId, title: 'Second title' },
    ],
    outputs: {
      ['first' as PortId]: firstValue,
      ['second' as PortId]: secondValue,
    },
    isCompact: false,
  });

  assert.deepEqual(
    sections.map((section) => ({
      headerMode: section.headerMode,
      label: section.label,
      portId: section.portId,
      value: section.value,
    })),
    [
      {
        headerMode: 'standard',
        label: 'First title',
        portId: 'first',
        value: firstValue,
      },
      {
        headerMode: 'standard',
        label: 'Second title',
        portId: 'second',
        value: secondValue,
      },
    ],
  );
});

test('createNodeOutputSectionsViewModel uses the first visible output in compact mode', () => {
  const firstValue = inlineStored('string', 'first');
  const secondValue = inlineStored('string', 'second');
  const sections = createNodeOutputSectionsViewModel({
    outputs: {
      [WarningsPort as PortId]: inlineStored('string[]', ['warning']),
      ['first' as PortId]: firstValue,
      ['second' as PortId]: secondValue,
    },
    isCompact: true,
  });

  assert.deepEqual(
    sections.map((section) => ({
      headerMode: section.headerMode,
      label: section.label,
      portId: section.portId,
      value: section.value,
    })),
    [
      {
        headerMode: 'hidden',
        label: 'first',
        portId: 'first',
        value: firstValue,
      },
    ],
  );
});

test('createFullscreenNodeOutputViewModel reports the selected visible process and total pages', () => {
  const oldProcess = process('old', {
    outputData: {
      ['output' as PortId]: inlineStored('string', 'old'),
    },
  });
  const runningProcess = process('running', {
    status: { type: 'running' },
  });

  const selectedOld = createFullscreenNodeOutputViewModel({
    nodeType: 'text',
    processData: [oldProcess, runningProcess],
    selectedPage: 0,
    dataRefs: createDataRefStore(),
  });
  const selectedLatest = createFullscreenNodeOutputViewModel({
    nodeType: 'text',
    processData: [oldProcess, runningProcess],
    selectedPage: 'latest',
    dataRefs: createDataRefStore(),
  });

  assert.equal(selectedOld.kind, 'content');
  assert.equal(selectedOld.totalPages, 2);
  assert.equal(selectedOld.processId, oldProcess.processId);
  assert.equal(selectedLatest.kind, 'empty');
  assert.equal(selectedLatest.totalPages, 2);
});

test('createFullscreenNodeOutputViewModel can select duration-only output when enabled', () => {
  const durationProcess = process('duration', {
    durationMs: 20,
    status: { type: 'ok' },
  });

  assert.equal(
    createFullscreenNodeOutputViewModel({
      nodeType: 'text',
      processData: [durationProcess],
      selectedPage: 'latest',
      dataRefs: createDataRefStore(),
    }).kind,
    'empty',
  );

  const outputViewModel = createFullscreenNodeOutputViewModel({
    nodeType: 'text',
    processData: [durationProcess],
    selectedPage: 'latest',
    dataRefs: createDataRefStore(),
    showNodeRunDuration: true,
  });

  assert.equal(outputViewModel.kind, 'content');
  assert.equal(outputViewModel.kind === 'content' ? outputViewModel.data.durationMs : undefined, 20);
});

test('node output copy view-model helpers keep display copy and JSON copy separate', () => {
  const data = {
    outputData: {
      ['output' as PortId]: inlineStored('string', 'hello'),
    },
  } as NodeRunDataWithRefs;
  const dataRefs = createDataRefStore();

  assert.equal(serializeNodeOutputDisplayCopy(data, dataRefs), 'hello');
  assert.equal(
    serializeNodeOutputJsonCopy(data, dataRefs),
    JSON.stringify(
      {
        output: {
          type: 'string',
          value: 'hello',
        },
      },
      null,
      2,
    ),
  );
});
