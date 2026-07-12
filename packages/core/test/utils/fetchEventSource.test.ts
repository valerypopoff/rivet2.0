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
    const response = new EventSourceResponse(new ReadableStream<Uint8Array>({ start() {} }), undefined, 5);

    await assert.rejects(async () => {
      for await (const _event of response.events()) {
        // The test stream deliberately never produces an event.
      }
    }, /Timeout: API response took too long\./);
  });
});
