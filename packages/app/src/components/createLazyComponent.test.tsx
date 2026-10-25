import assert from 'node:assert/strict';
import test from 'node:test';
import type React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createLazyComponent } from './createLazyComponent.js';

test('lazy features share initial loading, use current props, retry explicitly and settle after unmount', async (t) => {
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  let resolve!: (module: { default: React.FC<{ value: string }> }) => void;
  let calls = 0;
  const pending = new Promise<{ default: React.FC<{ value: string }> }>((done) => {
    resolve = done;
  });
  const Content: React.FC<{ value: string }> = ({ value }) => (
    <input aria-label="Loaded value" value={value} readOnly />
  );
  const Lazy = createLazyComponent(() => {
    calls++;
    return pending;
  }, 'fixture');
  try {
    await act(async () =>
      root.render(
        <>
          <Lazy value="old" />
          <Lazy value="other" />
        </>,
      ),
    );
    assert.equal(calls, 1);
    assert.match(dom.window.document.body.textContent!, /Loading fixture/);
    await act(async () =>
      root.render(
        <>
          <Lazy value="current" />
          <Lazy value="other" />
        </>,
      ),
    );
    await act(async () => resolve({ default: Content }));
    assert.equal(dom.window.document.querySelector('input')!.value, 'current');
    assert.equal(calls, 1);

    const errors = t.mock.method(console, 'error', () => {});
    let attempts = 0;
    const Retry = createLazyComponent(async () => {
      if (++attempts === 1) throw new Error('Transient fixture import');
      return { default: Content };
    }, 'retry fixture');
    await act(async () => root.render(<Retry value="preserved" />));
    assert.equal(attempts, 1);
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Could not load/);
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button')!.click());
    assert.equal(attempts, 2);
    assert.equal(dom.window.document.querySelector('input')!.value, 'preserved');
    await act(async () => root.render(null));
    await act(async () => root.render(<Retry value="reopened" />));
    assert.equal(dom.window.document.querySelector('input')?.value, 'reopened');
    assert.equal(attempts, 2, 'A recovered import must remain usable on subsequent mounts');
    errors.mock.restore();

    let finish!: () => void;
    const Closed = createLazyComponent<{ value: string }>(
      () =>
        new Promise((done) => {
          finish = () => done({ default: Content });
        }),
      'closed fixture',
    );
    await act(async () => root.render(<Closed value="not reopened" />));
    await act(async () => root.render(null));
    await act(async () => finish());
    assert.equal(dom.window.document.getElementById('root')!.childElementCount, 0);
  } finally {
    await act(async () => root.unmount());
    keys.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!);
      else delete (globalThis as any)[key];
    });
    dom.window.close();
  }
});
