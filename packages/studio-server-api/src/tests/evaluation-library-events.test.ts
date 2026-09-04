import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  notifyEvaluationLibraryChanged,
  openEvaluationLibraryEventStream,
} from '../routes/workflows/evaluation-library-events.js';

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  writableEnded = false;

  status(): this {
    return this;
  }

  setHeader(): void {}

  flushHeaders(): void {}

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}

test('Evaluation Library events use real SSE delimiters and retain the source client id', () => {
  const request = new EventEmitter() as EventEmitter & { get(name: string): string | undefined };
  request.get = (name) => (name === 'x-rivet-evaluation-library-client-id' ? 'browser-a' : undefined);
  const response = new FakeResponse();

  openEvaluationLibraryEventStream(request as never, response as never, 7);
  assert.match(response.writes[0] ?? '', /^event: library-state\ndata: /u);
  assert.match(response.writes[0] ?? '', /\n\n$/u);

  notifyEvaluationLibraryChanged(request as never, 8);
  assert.match(response.writes[1] ?? '', /^event: library-changed\ndata: /u);
  assert.match(response.writes[1] ?? '', /"sourceClientId":"browser-a"/u);

  request.emit('close');
});
