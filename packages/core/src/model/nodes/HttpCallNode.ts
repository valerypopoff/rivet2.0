import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { type EditorDefinition, type InternalProcessContext } from '../../index.js';
import { coerceType, dedent, getInputOrData } from '../../utils/index.js';
import { getError } from '../../utils/errors.js';

const REQUEST_FAILED_OUTPUT_ID = 'requestFailed' as PortId;
const REQUEST_ERROR_OUTPUT_ID = 'requestError' as PortId;
const STATUS_CODE_OUTPUT_ID = 'statusCode' as PortId;
const RESPONSE_HEADERS_OUTPUT_ID = 'res_headers' as PortId;
const DEFAULT_RETRY_ON_NON_200_REPEAT_TIMES = 1;
const DEFAULT_RETRY_ON_NON_200_COOLDOWN_MS = 0;

type HttpCallRequestAttempts = {
  statusCodeValues: number[];
  responseHeaderValues: Record<string, string>[];
  requestFailedValues: boolean[];
  requestErrorMessages: string[];
};

type ExcludedOutput = {
  type: 'control-flow-excluded';
  value: undefined;
};

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || getError(error).name === 'AbortError';
}

function buildNon2xxStatusCodeError(statusCode: number): Error {
  return new Error(`HTTP call returned non-2XX status code: ${statusCode}`);
}

function stringifyNonErrorValue(value: unknown): string {
  if (value == null) {
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (_error) {
    return String(value);
  }
}

function formatCaughtRequestFailureError(error: unknown, seen = new Set<unknown>()): string {
  if (error && typeof error === 'object') {
    if (seen.has(error)) {
      return '[Circular error reference]';
    }
    seen.add(error);
  }

  if (error instanceof Error) {
    const errorText = error.stack?.trim() || `${error.name}: ${error.message}`.trim();
    const cause = (error as Error & { cause?: unknown }).cause;

    if (cause == null) {
      return errorText;
    }

    return `${errorText}\n\nCaused by: ${formatCaughtRequestFailureError(cause, seen)}`;
  }

  return stringifyNonErrorValue(error);
}

function createHttpCallRequestAttempts(): HttpCallRequestAttempts {
  return {
    statusCodeValues: [],
    responseHeaderValues: [],
    requestFailedValues: [],
    requestErrorMessages: [],
  };
}

function getHttpCallResponseHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

function recordHttpCallResponseAttempt(attempts: HttpCallRequestAttempts, response: Response): void {
  const requestFailed = response.status !== 200;

  attempts.statusCodeValues.push(response.status);
  attempts.responseHeaderValues.push(getHttpCallResponseHeaders(response));
  attempts.requestFailedValues.push(requestFailed);

  if (requestFailed) {
    attempts.requestErrorMessages.push(formatCaughtRequestFailureError(buildNon2xxStatusCodeError(response.status)));
  }
}

function recordHttpCallThrownAttempt(attempts: HttpCallRequestAttempts, error: unknown, signal: AbortSignal): void {
  if (isAbortError(error, signal)) {
    return;
  }

  attempts.requestFailedValues.push(true);
  attempts.requestErrorMessages.push(formatCaughtRequestFailureError(error));
}

function buildRetryAttemptOutput(
  type: 'number[]',
  values: number[],
): { type: 'number[]'; value: number[] } | ExcludedOutput;
function buildRetryAttemptOutput(
  type: 'boolean[]',
  values: boolean[],
): { type: 'boolean[]'; value: boolean[] } | ExcludedOutput;
function buildRetryAttemptOutput(
  type: 'string[]',
  values: string[],
): { type: 'string[]'; value: string[] } | ExcludedOutput;
function buildRetryAttemptOutput(
  type: 'object[]',
  values: Record<string, string>[],
): { type: 'object[]'; value: Record<string, string>[] } | ExcludedOutput;
function buildRetryAttemptOutput(
  type: 'number[]' | 'boolean[]' | 'string[]' | 'object[]',
  values: number[] | boolean[] | string[] | Record<string, string>[],
) {
  return values.length > 0
    ? {
        type,
        value: values,
      }
    : {
        type: 'control-flow-excluded' as const,
        value: undefined,
      };
}

function buildHttpCallResponseMetadataOutputs(
  response: Response,
  requestAttempts: HttpCallRequestAttempts | undefined,
): Outputs {
  return {
    [STATUS_CODE_OUTPUT_ID]: requestAttempts
      ? buildRetryAttemptOutput('number[]', requestAttempts.statusCodeValues)
      : {
          type: 'number',
          value: response.status,
        },
    [RESPONSE_HEADERS_OUTPUT_ID]: requestAttempts
      ? buildRetryAttemptOutput('object[]', requestAttempts.responseHeaderValues)
      : {
          type: 'object',
          value: getHttpCallResponseHeaders(response),
        },
  };
}

function isCaughtFailureAlreadyRecorded(attempts: HttpCallRequestAttempts, error: unknown): boolean {
  const formattedError = formatCaughtRequestFailureError(error);
  if (attempts.requestErrorMessages.at(-1) === formattedError) {
    return true;
  }

  const lastStatusCode = attempts.statusCodeValues.at(-1);

  if (lastStatusCode == null || !(error instanceof Error)) {
    return false;
  }

  const expectedStatusErrorMessage = buildNon2xxStatusCodeError(lastStatusCode).message;
  return (
    error.message === expectedStatusErrorMessage &&
    attempts.requestErrorMessages.at(-1)?.includes(error.message) === true
  );
}

function withCaughtFailureAttemptFallback(attempts: HttpCallRequestAttempts, error: unknown): HttpCallRequestAttempts {
  if (isCaughtFailureAlreadyRecorded(attempts, error)) {
    return attempts;
  }

  const requestFailedValues = attempts.requestFailedValues.length > 0 ? [...attempts.requestFailedValues] : [true];
  requestFailedValues[requestFailedValues.length - 1] = true;

  return {
    ...attempts,
    requestFailedValues,
    requestErrorMessages: [...attempts.requestErrorMessages, formatCaughtRequestFailureError(error)],
  };
}

function normalizeHttpRetryCount(value: number | undefined): number {
  const retryCount =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_RETRY_ON_NON_200_REPEAT_TIMES;
  return Math.max(1, Math.floor(retryCount));
}

function normalizeHttpRetryCooldownMs(value: number | undefined): number {
  const cooldownMs = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_RETRY_ON_NON_200_COOLDOWN_MS;
  return Math.max(0, Math.floor(cooldownMs));
}

function buildAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function waitForRetryCooldown(cooldownMs: number, signal: AbortSignal): Promise<void> {
  if (cooldownMs <= 0) {
    return;
  }

  if (signal.aborted) {
    throw buildAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, cooldownMs);

    function cleanup() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }

    function onAbort() {
      cleanup();
      reject(buildAbortError());
    }

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function buildRequestFailedOutputs(params: {
  isBinaryOutput: boolean;
  retryOnNon200: boolean;
  attempts: HttpCallRequestAttempts;
}): Outputs {
  const sharedOutputs: Outputs = {
    [STATUS_CODE_OUTPUT_ID]: params.retryOnNon200
      ? buildRetryAttemptOutput('number[]', params.attempts.statusCodeValues)
      : {
          type: 'control-flow-excluded',
          value: undefined,
        },
    [RESPONSE_HEADERS_OUTPUT_ID]: {
      type: 'control-flow-excluded',
      value: undefined,
    },
  };

  if (params.isBinaryOutput) {
    return {
      ...sharedOutputs,
      ['binary' as PortId]: {
        type: 'control-flow-excluded',
        value: undefined,
      },
    };
  }

  return {
    ...sharedOutputs,
    ['res_body' as PortId]: {
      type: 'control-flow-excluded',
      value: undefined,
    },
    ['json' as PortId]: {
      type: 'control-flow-excluded',
      value: undefined,
    },
  };
}

function buildCaughtRequestFailedResult(params: {
  isBinaryOutput: boolean;
  error: unknown;
  retryOnNon200: boolean;
  attempts: HttpCallRequestAttempts;
}): Outputs {
  const attempts = params.retryOnNon200
    ? withCaughtFailureAttemptFallback(params.attempts, params.error)
    : params.attempts;

  const outputs: Outputs = {
    [REQUEST_ERROR_OUTPUT_ID]: params.retryOnNon200
      ? buildRetryAttemptOutput('string[]', attempts.requestErrorMessages)
      : {
          type: 'string',
          value: formatCaughtRequestFailureError(params.error),
        },
    [REQUEST_FAILED_OUTPUT_ID]: params.retryOnNon200
      ? buildRetryAttemptOutput('boolean[]', attempts.requestFailedValues)
      : {
          type: 'boolean',
          value: true,
        },
    ...buildRequestFailedOutputs({
      isBinaryOutput: params.isBinaryOutput,
      retryOnNon200: params.retryOnNon200,
      attempts,
    }),
  };

  return outputs;
}

export type HttpCallNode = ChartNode<'httpCall', HttpCallNodeData>;

export type HttpCallNodeData = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  useMethodInput?: boolean;

  url: string;
  useUrlInput?: boolean;

  headers: string;
  useHeadersInput?: boolean;

  body: string;
  useBodyInput?: boolean;

  isBinaryOutput?: boolean;

  errorOnNon200?: boolean;
  catchRequestFailed?: boolean;
  retryOnNon200?: boolean;
  retryOnNon200RepeatTimes?: number;
  retryOnNon200CooldownMs?: number;
};

export function getHttpCallBodyPreviewSections(data: HttpCallNodeData): string[] {
  const sections = [
    `${data.useMethodInput ? '(Method Using Input)' : data.method} ${data.useUrlInput ? '(URL Using Input)' : data.url}`,
  ];

  if (data.useHeadersInput) {
    sections.push('Headers: (Using Input)');
  } else if (data.headers.trim()) {
    sections.push(`Headers: ${data.headers}`);
  }

  if (data.useBodyInput) {
    sections.push('Body: (Using Input)');
  } else if (data.body.trim()) {
    sections.push(`Body: ${data.body}`);
  }

  if (data.errorOnNon200) {
    sections.push('Throw on non-2XX');
  }

  if (data.catchRequestFailed) {
    sections.push('Catch all request failures');
  }

  if (data.retryOnNon200) {
    const cooldownMs = normalizeHttpRetryCooldownMs(data.retryOnNon200CooldownMs);
    const retrySummaryParts = [`${normalizeHttpRetryCount(data.retryOnNon200RepeatTimes)} repeats`];

    if (cooldownMs) {
      retrySummaryParts.push(`${cooldownMs}ms cooldown`);
    }

    sections.push(`Retry on non-200 (${retrySummaryParts.join(', ')})`);
  }

  return sections;
}

export class HttpCallNodeImpl extends NodeImpl<HttpCallNode> {
  static create(): HttpCallNode {
    const chartNode: HttpCallNode = {
      type: 'httpCall',
      title: 'Http Call',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        method: 'GET',
        url: '',
        headers: '',
        body: '',
        errorOnNon200: true,
        catchRequestFailed: false,
        retryOnNon200: false,
        retryOnNon200RepeatTimes: DEFAULT_RETRY_ON_NON_200_REPEAT_TIMES,
        retryOnNon200CooldownMs: DEFAULT_RETRY_ON_NON_200_COOLDOWN_MS,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];

    if (this.data.useMethodInput) {
      inputs.push({
        dataType: 'string',
        id: 'method' as PortId,
        title: 'Method',
      });
    }

    if (this.data.useUrlInput) {
      inputs.push({
        dataType: 'string',
        id: 'url' as PortId,
        title: 'URL',
      });
    }

    if (this.data.useHeadersInput) {
      inputs.push({
        dataType: 'object',
        id: 'headers' as PortId,
        title: 'Headers',
      });
    }

    if (this.data.useBodyInput) {
      inputs.push({
        dataType: 'string',
        id: 'req_body' as PortId,
        title: 'Body',
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputDefinitions: NodeOutputDefinition[] = [];
    if (this.data.isBinaryOutput) {
      outputDefinitions.push({
        dataType: 'binary',
        id: 'binary' as PortId,
        title: 'Binary',
      });
    } else {
      outputDefinitions.push(
        {
          dataType: 'string',
          id: 'res_body' as PortId,
          title: 'Body',
        },
        {
          dataType: 'object',
          id: 'json' as PortId,
          title: 'Parsed JSON',
        },
      );
    }

    outputDefinitions.push(
      {
        dataType: this.data.retryOnNon200 ? 'number[]' : 'number',
        id: STATUS_CODE_OUTPUT_ID,
        title: 'Status Code',
      },
      {
        dataType: this.data.retryOnNon200 ? 'object[]' : 'object',
        id: RESPONSE_HEADERS_OUTPUT_ID,
        title: 'Headers',
      },
    );

    if (this.data.catchRequestFailed || this.data.retryOnNon200) {
      outputDefinitions.push(
        {
          dataType: this.data.retryOnNon200 ? 'boolean[]' : 'boolean',
          id: REQUEST_FAILED_OUTPUT_ID,
          title: 'Request failed',
        },
        {
          dataType: this.data.retryOnNon200 ? 'string[]' : 'string',
          id: REQUEST_ERROR_OUTPUT_ID,
          title: 'Request error',
        },
      );
    }

    return outputDefinitions;
  }

  getEditors(): EditorDefinition<HttpCallNode>[] {
    return [
      {
        type: 'dropdown',
        label: 'Method',
        dataKey: 'method',
        useInputToggleDataKey: 'useMethodInput',
        options: [
          { label: 'GET', value: 'GET' },
          { label: 'POST', value: 'POST' },
          { label: 'PUT', value: 'PUT' },
          { label: 'DELETE', value: 'DELETE' },
        ],
      },
      {
        type: 'string',
        label: 'URL',
        dataKey: 'url',
        useInputToggleDataKey: 'useUrlInput',
      },
      {
        type: 'code',
        label: 'Headers',
        dataKey: 'headers',
        useInputToggleDataKey: 'useHeadersInput',
        language: 'json',
        enableFolding: true,
      },
      {
        type: 'code',
        label: 'Body',
        dataKey: 'body',
        useInputToggleDataKey: 'useBodyInput',
        language: 'json',
        enableFolding: true,
      },
      {
        type: 'group',
        label: 'Retry on non-200',
        toggleDataKey: 'retryOnNon200',
        editors: [
          {
            type: 'number',
            label: 'Repeat times',
            dataKey: 'retryOnNon200RepeatTimes',
            defaultValue: DEFAULT_RETRY_ON_NON_200_REPEAT_TIMES,
            min: 1,
            step: 1,
            layout: 'inline',
            helperMessage: 'Times to repeat after the initial request',
          },
          {
            type: 'number',
            label: 'Cooldown, ms',
            dataKey: 'retryOnNon200CooldownMs',
            defaultValue: DEFAULT_RETRY_ON_NON_200_COOLDOWN_MS,
            min: 0,
            step: 1,
            layout: 'inline',
            helperMessage: 'Milliseconds to wait between repeats',
          },
        ],
      },
      {
        type: 'toggle',
        label: 'Binary Output',
        dataKey: 'isBinaryOutput',
        helperMessage: 'Toggle on if the response is expected to be binary data',
      },
      {
        type: 'toggle',
        label: 'Fail on non-2XX status code',
        dataKey: 'errorOnNon200',
        helperMessage: (data) =>
          data.retryOnNon200
            ? 'With Retry on non-200 enabled, only the final response after all retries is checked.'
            : undefined,
      },
      {
        type: 'toggle',
        label: 'Catch all request failures',
        dataKey: 'catchRequestFailed',
      },
    ];
  }

  getBody(): string {
    return getHttpCallBodyPreviewSections(this.data).join('\n');
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Makes an HTTP call to the specified URL with the given method, headers, and body.
      `,
      infoBoxTitle: 'HTTP Call Node',
      contextMenuTitle: 'HTTP Call',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const requestAttempts = this.data.retryOnNon200 ? createHttpCallRequestAttempts() : undefined;

    try {
      const method = getInputOrData(this.data, inputs, 'method', 'string');
      const url = getInputOrData(this.data, inputs, 'url', 'string');

      let headers: Record<string, string> | undefined;
      if (this.data.useHeadersInput) {
        const headersInput = inputs['headers' as PortId];
        if (headersInput?.type === 'string') {
          headers = JSON.parse(headersInput!.value);
        } else if (headersInput?.type === 'object') {
          headers = headersInput!.value as Record<string, string>;
        } else {
          headers = coerceType(headersInput, 'object') as Record<string, string>;
        }
      } else if (this.data.headers.trim()) {
        headers = JSON.parse(this.data.headers);
      }

      let body: string | undefined;
      if (this.data.useBodyInput) {
        const bodyInput = inputs['req_body' as PortId];
        if (bodyInput?.type === 'string') {
          body = bodyInput!.value;
        } else if (bodyInput?.type === 'object') {
          body = JSON.stringify(bodyInput!.value);
        } else {
          body = coerceType(bodyInput, 'string');
        }
      } else {
        body = this.data.body || undefined;
      }

      try {
        // TODO: Use URL.canParse when we drop support for Node 18
        new URL(url);
      } catch (_error) {
        throw new Error(`Invalid URL: ${url}`);
      }

      const performRequest = async () => {
        try {
          return await fetch(url, {
            method,
            headers,
            body,
            signal: context.signal,
            mode: 'cors',
          });
        } catch (err) {
          if (isAbortError(err, context.signal)) {
            throw err;
          }

          const { message } = getError(err);
          if (
            (message.includes('Load failed') || message.includes('Failed to fetch')) &&
            context.executor === 'browser'
          ) {
            throw new Error(
              'Failed to make HTTP call. You may be running into CORS problems. Try using the Node executor in the top-right menu.',
              { cause: err },
            );
          }

          throw err;
        }
      };

      const performTrackedRequest = requestAttempts
        ? async () => {
            try {
              const response = await performRequest();
              recordHttpCallResponseAttempt(requestAttempts, response);
              return response;
            } catch (error) {
              recordHttpCallThrownAttempt(requestAttempts, error, context.signal);
              throw error;
            }
          }
        : performRequest;

      let response = await performTrackedRequest();

      if (requestAttempts) {
        const repeatTimes = normalizeHttpRetryCount(this.data.retryOnNon200RepeatTimes);
        const cooldownMs = normalizeHttpRetryCooldownMs(this.data.retryOnNon200CooldownMs);

        for (let attempt = 0; response.status !== 200 && attempt < repeatTimes; attempt++) {
          await waitForRetryCooldown(cooldownMs, context.signal);
          response = await performTrackedRequest();
        }
      }

      const responseMetadataOutputs = buildHttpCallResponseMetadataOutputs(response, requestAttempts);

      if (this.data.errorOnNon200 && !response.ok) {
        // The request reached the server, so retain its response metadata for
        // display on the terminal nodeError. It remains inspection evidence,
        // never a successful graph output. Caught failures return their
        // existing normal output contract instead and must not leave a stale
        // failure checkpoint behind.
        if (!this.data.catchRequestFailed) {
          // GraphProcessor supplies the durable terminal channel. Direct/custom
          // node consumers receive the same metadata through their ordinary
          // live-output callback when that channel is unavailable.
          if (context.setFailureOutputs) {
            context.setFailureOutputs(responseMetadataOutputs);
          } else {
            context.onPartialOutputs?.(responseMetadataOutputs);
          }
        }
        throw buildNon2xxStatusCodeError(response.status);
      }

      const output: Outputs = responseMetadataOutputs;

      if (this.data.isBinaryOutput) {
        const responseBlob = await response.blob();
        output['binary' as PortId] = {
          type: 'binary',
          value: new Uint8Array(await responseBlob.arrayBuffer()),
        };
      } else {
        const responseText = await response.text();
        output['res_body' as PortId] = {
          type: 'string',
          value: responseText,
        };
        if (response.headers.get('content-type')?.includes('application/json')) {
          const jsonData = JSON.parse(responseText);
          output['json' as PortId] = {
            type: 'object',
            value: jsonData,
          };
        } else {
          output['json' as PortId] = {
            type: 'control-flow-excluded',
            value: undefined,
          };
        }
      }

      if (this.data.catchRequestFailed || requestAttempts) {
        output[REQUEST_FAILED_OUTPUT_ID] = requestAttempts
          ? buildRetryAttemptOutput('boolean[]', requestAttempts.requestFailedValues)
          : {
              type: 'boolean',
              value: false,
            };
        output[REQUEST_ERROR_OUTPUT_ID] = requestAttempts
          ? buildRetryAttemptOutput('string[]', requestAttempts.requestErrorMessages)
          : {
              type: 'control-flow-excluded',
              value: undefined,
            };
      }

      return output;
    } catch (error) {
      if (this.data.catchRequestFailed && !isAbortError(error, context.signal)) {
        return buildCaughtRequestFailedResult({
          isBinaryOutput: Boolean(this.data.isBinaryOutput),
          error,
          retryOnNon200: requestAttempts != null,
          attempts: requestAttempts ?? createHttpCallRequestAttempts(),
        });
      }

      throw error;
    }
  }
}

export const httpCallNode = nodeDefinition(HttpCallNodeImpl, 'Http Call');
