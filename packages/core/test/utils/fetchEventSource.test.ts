import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fetchEventSource, { EventSourceResponse } from '../../src/utils/fetchEventSource.js';

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createByteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collectEvents(response: EventSourceResponse): Promise<string[]> {
  const events: string[] = [];
  for await (const event of response.events()) {
    events.push(event);
  }
  return events;
}

void describe('fetchEventSource', () => {
  void it('preserves supplied headers while forcing the SSE accept header and parsing event records', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let request: Request | undefined;

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init);
        return new Response(createStream(['event: message_start\ndata: {"type":"message_start"}\n\n']));
      },
    });

    try {
      const response = await fetchEventSource('https://example.test/stream', {
        headers: new Headers({ accept: 'application/json', 'x-provider-key': 'secret' }),
      });

      assert.equal(request?.headers.get('accept'), 'text/event-stream');
      assert.equal(request?.headers.get('x-provider-key'), 'secret');
      assert.deepEqual(await collectEvents(response), ['[message_start]', '{"type":"message_start"}']);
    } finally {
      if (originalFetch == null) {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      } else {
        Object.defineProperty(globalThis, 'fetch', originalFetch);
      }
    }
  });

  void it('rejects a stalled event reader using the supplied timeout', async () => {
    let cancelCount = 0;
    const response = new EventSourceResponse(
      new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          cancelCount += 1;
        },
      }),
      undefined,
      5,
    );

    await assert.rejects(async () => {
      for await (const _event of response.events()) {
        // The test stream deliberately never produces an event.
      }
    }, /Timeout: API response took too long\./);

    assert.equal(cancelCount, 1);
    assert.equal(response.streams?.eventStream.locked, false);
  });

  void it('retains the raw response only when the event branch produces no recognized output', async () => {
    const fallback = new EventSourceResponse(createStream(['{"error":"provider failure"}']));
    assert.deepEqual(await collectEvents(fallback), []);
    assert.deepEqual(await fallback.json(), { error: 'provider failure' });

    const streamed = new EventSourceResponse(createStream(['data: first\n', 'data: second\n']));
    assert.deepEqual(await collectEvents(streamed), ['first', 'second']);
    await assert.rejects(streamed.text(), /Body is unusable|body stream is locked|aborted/i);
  });

  void it('cancels both stream branches when a consumer stops before the provider stream ends', async () => {
    let cancelCount = 0;
    const encoder = new TextEncoder();
    const response = new EventSourceResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: first\n'));
        },
        cancel() {
          cancelCount += 1;
        },
      }),
    );

    for await (const event of response.events()) {
      assert.equal(event, 'first');
      break;
    }

    assert.equal(cancelCount, 1);
    assert.equal(response.streams?.eventStream.locked, false);
  });

  void it('preserves the legacy line-tokenizer contract across chunk and UTF-8 boundaries', async () => {
    const encoded = new TextEncoder().encode('event: content\ndata: {"text":"Привет"}\n');
    const unicodeBoundary = encoded.indexOf(0xd0);
    const response = new EventSourceResponse(
      createByteStream([
        encoded.slice(0, 4),
        encoded.slice(4, unicodeBoundary + 1),
        encoded.slice(unicodeBoundary + 1),
      ]),
    );

    assert.deepEqual(await collectEvents(response), ['[content]', '{"text":"Привет"}']);
  });

  void it('keeps CRLF, multiline data, comments, final-line, and strict field-prefix behavior stable', async () => {
    const response = new EventSourceResponse(
      createStream([
        ': comment\r\n',
        'event: update\r\n',
        'data: first\r\n',
        'data: second\r\n',
        'data:ignored-without-space\r\n',
        'id: ignored\r\n',
        '\r\n',
        'data: [DONE]',
      ]),
    );

    assert.deepEqual(await collectEvents(response), ['[update]', 'first', 'second', '[DONE]']);
  });

  void it('preserves event-only records and ignores unrecognized fields', async () => {
    const response = new EventSourceResponse(
      createStream(['event: ping\nretry: 1000\nunknown: value\n\n', 'event: complete\n']),
    );

    assert.deepEqual(await collectEvents(response), ['[ping]', '[complete]']);
  });

  void it('pins the legacy bare-CR and BOM behavior instead of silently adopting record-level SSE parsing', async () => {
    const response = new EventSourceResponse(
      createStream(['event: update\rdata: combined\r', '\n\uFEFFdata: ignored\n', 'data: accepted\n']),
    );

    assert.deepEqual(await collectEvents(response), ['[update\rdata: combined]', 'accepted']);
  });

  void it('passes the caller abort signal through to fetch unchanged', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedSignal = init?.signal;
        return new Response(null);
      },
    });

    try {
      await fetchEventSource('https://example.test/stream', { signal: controller.signal });
      assert.equal(receivedSignal, controller.signal);
    } finally {
      if (originalFetch == null) {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      } else {
        Object.defineProperty(globalThis, 'fetch', originalFetch);
      }
    }
  });

  void it('retains the raw response branch for fallback JSON and response metadata', async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: async () =>
        new Response(JSON.stringify({ error: { message: 'provider failure' } }), {
          headers: { 'content-type': 'application/json', 'x-request-id': 'request-id' },
          status: 429,
          statusText: 'Too Many Requests',
        }),
    });

    try {
      const response = await fetchEventSource('https://example.test/error');

      assert.equal(response.status, 429);
      assert.equal(response.statusText, 'Too Many Requests');
      assert.equal(response.headers.get('x-request-id'), 'request-id');
      assert.deepEqual(await response.json(), { error: { message: 'provider failure' } });
    } finally {
      if (originalFetch == null) {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      } else {
        Object.defineProperty(globalThis, 'fetch', originalFetch);
      }
    }
  });
});
