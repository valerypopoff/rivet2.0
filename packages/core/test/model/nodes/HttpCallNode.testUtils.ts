import { afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  getHttpCallBodyPreviewSections,
  HttpCallNodeImpl,
  type EditorDefinition,
  type HttpCallNode,
  type InternalProcessContext,
  type Outputs,
  type PortId,
} from '../../../src/index.js';

export { getHttpCallBodyPreviewSections, HttpCallNodeImpl };

const originalFetch = globalThis.fetch;
let hooksInstalled = false;
export const requestFailedOutputId = 'requestFailed' as PortId;
export const requestErrorOutputId = 'requestError' as PortId;
export const statusCodeOutputId = 'statusCode' as PortId;

const expectedTextRequestFailedOutputs: Outputs = {
  res_body: { type: 'control-flow-excluded', value: undefined },
  json: { type: 'control-flow-excluded', value: undefined },
  statusCode: { type: 'control-flow-excluded', value: undefined },
  res_headers: { type: 'control-flow-excluded', value: undefined },
  requestFailed: { type: 'boolean', value: true },
};

export const createNode = (data: Partial<HttpCallNode['data']>) => {
  const node = HttpCallNodeImpl.create();
  return new HttpCallNodeImpl({ ...node, data: { ...node.data, ...data } });
};

export const createContext = ({
  executor = 'nodejs',
  signal = new AbortController().signal,
}: {
  executor?: 'nodejs' | 'browser';
  signal?: AbortSignal;
} = {}) =>
  ({
    executor,
    signal,
    graphInputNodeValues: {},
    contextValues: {},
  }) as InternalProcessContext;

export const flattenEditors = (editors: EditorDefinition<HttpCallNode>[]): EditorDefinition<HttpCallNode>[] =>
  editors.flatMap((editor) => (editor.type === 'group' ? [editor, ...flattenEditors(editor.editors)] : [editor]));

export const getStringOutputValue = (outputs: Outputs, portId: PortId): string => {
  const output = outputs[portId];
  if (output?.type !== 'string') {
    assert.fail(`Expected ${portId} to be a string output`);
  }
  return output.value;
};

export const assertCaughtTextRequestFailure = (outputs: Outputs, expectedErrorParts: RegExp[]) => {
  const { [requestErrorOutputId]: errorOutput, ...outputsExceptError } = outputs;

  assert.equal(Object.keys(outputs)[0], requestErrorOutputId);
  assert.deepStrictEqual(outputsExceptError, expectedTextRequestFailedOutputs);
  assert.equal(errorOutput?.type, 'string');
  const errorText = getStringOutputValue(outputs, requestErrorOutputId);

  for (const expectedErrorPart of expectedErrorParts) {
    assert.match(errorText, expectedErrorPart);
  }
};

const assertStringArrayOutputMatches = (outputs: Outputs, portId: PortId, expectedErrorParts: RegExp[][]) => {
  const output = outputs[portId];

  assert.ok(output?.type === 'string[]', `Expected ${portId} to be a string[] output`);
  assert.equal(output.value.length, expectedErrorParts.length);

  expectedErrorParts.forEach((errorParts, index) => {
    for (const errorPart of errorParts) {
      assert.match(output.value[index]!, errorPart);
    }
  });
};

export const assertRetryAttemptOutputs = (
  outputs: Outputs,
  {
    statusCodeValues,
    requestFailedValues,
    requestErrorParts,
  }: {
    statusCodeValues?: number[];
    requestFailedValues: boolean[];
    requestErrorParts: RegExp[][];
  },
) => {
  assert.deepStrictEqual(
    outputs[statusCodeOutputId],
    statusCodeValues == null
      ? { type: 'control-flow-excluded', value: undefined }
      : { type: 'number[]', value: statusCodeValues },
  );
  assert.deepStrictEqual(outputs[requestFailedOutputId], {
    type: 'boolean[]',
    value: requestFailedValues,
  });
  assertStringArrayOutputMatches(outputs, requestErrorOutputId, requestErrorParts);
};

export function installHttpCallNodeTestHooks() {
  if (hooksInstalled) {
    return;
  }

  hooksInstalled = true;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
}
