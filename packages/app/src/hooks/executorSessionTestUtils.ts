import test from 'node:test';
import type { GraphOutputs } from '@valerypopoff/rivet2-core';
import { createExecutorSessionRuntime, type ExecutorSessionRuntime } from './executorSession';

export class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols?: string | string[];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  sent: string[] = [];

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(data: string) {
    this.sent.push(data);
  }

  emitClose(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    (this.onclose as ((event: { code: number }) => void) | null)?.({ code });
    this.dispatchEvent(new Event('close'));
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  emitRawMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent<string>);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  emitError() {
    this.onerror?.({ type: 'error' } as Event);
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalConsoleError = console.error;
let hooksInstalled = false;

export let sessionRevision = 0;
export let runtime: ExecutorSessionRuntime;

export const buildOutputs = (key: string, value: string): GraphOutputs => ({
  [key]: { type: 'string', value },
});

export function captureConsoleErrors() {
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  return logged;
}

export async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function installExecutorSessionTestHooks() {
  if (hooksInstalled) {
    return;
  }

  hooksInstalled = true;

  test.beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    sessionRevision = 0;
    runtime = createExecutorSessionRuntime({
      datasetProvider: {} as never,
      onStateChange: () => {
        sessionRevision += 1;
      },
    });
  });

  test.afterEach(() => {
    const socket = runtime.getRuntimeState().socket as unknown as FakeWebSocket | null;
    runtime.disconnect();
    socket?.emitClose();
    globalThis.WebSocket = originalWebSocket;
    console.error = originalConsoleError;
  });
}
