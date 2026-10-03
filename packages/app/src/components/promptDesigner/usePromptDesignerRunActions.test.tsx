import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Provider, createStore } from 'jotai';
import { createLLMChatV2NodeData } from '@valerypopoff/rivet2-core';
import { ProvidersProvider } from '../../providers/ProvidersContext.js';
import { promptDesignerResponseState } from '../../state/promptDesigner.js';
import { usePromptDesignerRunActions } from './usePromptDesignerRunActions.js';

for (const retirement of ['restart', 'attachment', 'unmount', 'completion'] as const) {
  test(`Prompt Designer ignores retired async work after ${retirement}`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://rivet.test/' });
    const keys = ['React', 'document', 'localStorage', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    const values = [React, dom.window.document, dom.window.localStorage, dom.window.navigator, dom.window, true];
    keys.forEach((key, index) => Object.defineProperty(globalThis, key, { configurable: true, value: values[index] }));
    const originalFetch = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const requests: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body.model);
      if (retirement === 'completion') {
        // Deliberately ignore AbortSignal to exercise the ownership check even
        // when the old transport returns after a newer request has started.
        await (body.model === 'retired' ? gate : currentGate);
      }
      return new Response(
        JSON.stringify({
          id: 'fixture',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'current response' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };
    let first = true;
    const environment = {
      async getEnvVar(name: string) {
        if (name === 'OPENAI_API_KEY' && first) {
          first = false;
          // This provider deliberately ignores cancellation, like an existing
          // host adapter whose settings lookup cannot be physically aborted.
          if (retirement !== 'completion') await gate;
        }
        return name === 'CUSTOM_PROVIDER_API_KEY' ? 'synthetic-key' : undefined;
      },
    };
    const store = createStore();
    let actions!: ReturnType<typeof usePromptDesignerRunActions>;
    const root = createRoot(dom.window.document.getElementById('root')!);
    let mounted = true;
    function Harness({ owner, model }: { owner: string; model: string }) {
      actions = usePromptDesignerRunActions({
        attachmentKey: owner,
        configData: {
          ...createLLMChatV2NodeData(),
          provider: 'custom',
          model,
          customProviderApi: 'completions',
          customProviderBaseURL: 'https://fixture.invalid/v1',
        },
        messages: [{ type: 'user', message: 'fixture' }],
      });
      return null;
    }
    const render = (owner: string, model: string) =>
      root.render(
        <Provider store={store}>
          <ProvidersProvider providers={{ environment }}>
            <Harness owner={owner} model={model} />
          </ProvidersProvider>
        </Provider>,
      );
    let pending: Promise<void> | undefined;
    let current: Promise<void> | undefined;
    try {
      await act(async () => render('A', 'retired'));
      await act(async () => {
        pending = actions.tryRunSingle();
      });
      assert.equal(actions.inProgress, true);
      assert.equal(first, false);
      if (retirement === 'unmount') {
        await act(async () => root.unmount());
        mounted = false;
      } else {
        if (retirement === 'attachment') {
          await act(async () => render('B', 'current'));
          await act(async () => render('A', 'current'));
        } else {
          await act(async () => render('A', 'current'));
        }
        if (retirement === 'completion') {
          await act(async () => {
            current = actions.tryRunSingle();
          });
          await act(async () => {
            release();
            await pending;
          });
          assert.equal(actions.inProgress, true);
          assert.deepEqual(store.get(promptDesignerResponseState), {});
          await act(async () => {
            releaseCurrent();
            await current;
          });
        } else {
          await act(async () => actions.tryRunSingle());
        }
        assert.equal(store.get(promptDesignerResponseState).response, 'current response');
        assert.equal(actions.inProgress, false);
      }
      await act(async () => {
        release();
        await pending;
      });
      assert.deepEqual(
        requests,
        retirement === 'unmount' ? [] : retirement === 'completion' ? ['retired', 'current'] : ['current'],
      );
      assert.deepEqual(
        store.get(promptDesignerResponseState),
        retirement === 'unmount' ? {} : { response: 'current response' },
      );
    } finally {
      release();
      releaseCurrent();
      await act(async () => {
        await pending;
        await current;
        if (mounted) root.unmount();
      });
      globalThis.fetch = originalFetch;
      keys.forEach((key, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
      dom.window.close();
    }
  });
}
