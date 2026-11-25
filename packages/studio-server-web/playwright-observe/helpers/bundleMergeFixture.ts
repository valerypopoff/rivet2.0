import { expect, type Page, type Route } from '@playwright/test';
import { test as base } from './bundleApiFixture';

type PreviewGate = {
  path: string | null;
  parsed: boolean;
  consumed: boolean;
  aborted: boolean;
  released: Promise<void>;
  release(): void;
};
type MergeWindow = Window & { __mergePreviewGate?: PreviewGate; __mergePreviewReads?: number };

function releasePreviewGate() {
  const gate = (window as MergeWindow).__mergePreviewGate;
  if (gate) {
    gate.path = null;
    gate.release();
  }
}

/** Hold parsed preview bodies inside the shared bundle API lifetime. */
export const test = base.extend<{ mergePreviewIsolation: void }>({
  mergePreviewIsolation: [
    async ({ page, bundleApiIsolation: _bundleApiIsolation }, use) => {
      await page.addInitScript(() => {
        const owner = window as MergeWindow;
        owner.__mergePreviewReads = 0;
        const send = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const gate = owner.__mergePreviewGate;
          const input = args[0];
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
            location.href,
          );
          const body = args[1]?.body;
          const hold =
            gate &&
            url.pathname.endsWith('/merge/preview') &&
            typeof body === 'string' &&
            (JSON.parse(body) as { actions: Array<{ relativePath?: string }> }).actions.some(
              (action) => action.relativePath === gate.path,
            );
          if (hold) gate.path = null;
          const response = await send(...args);
          if (url.pathname.endsWith('/merge/preview')) {
            const parse = response.json.bind(response);
            response.json = async () => {
              const value: unknown = await parse();
              if (hold) {
                const signal = args[1]?.signal;
                gate.aborted = signal?.aborted ?? false;
                signal?.addEventListener('abort', () => (gate.aborted = true), { once: true });
                gate.parsed = true;
                await gate.released;
                gate.consumed = true;
              }
              owner.__mergePreviewReads!++;
              return value;
            };
          }
          return response;
        };
      });
      try {
        await use();
      } finally {
        // This fixture depends on API isolation so held bodies settle before route teardown.
        await page.evaluate(releasePreviewGate);
      }
    },
    { auto: true },
  ],
});

export async function consumedMergePreviews(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (window as MergeWindow).__mergePreviewReads)).toBe(count);
}

/** Hold already parsed bytes, so abort cannot hide a missing settlement fence. */
export async function holdMergePreview(page: Page, path: string) {
  await page.evaluate((path) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as MergeWindow).__mergePreviewGate = {
      path,
      parsed: false,
      consumed: false,
      aborted: false,
      released,
      release,
    };
  }, path);
  return {
    async parsed() {
      await expect.poll(() => page.evaluate(() => (window as MergeWindow).__mergePreviewGate?.parsed)).toBe(true);
    },
    async release() {
      await page.evaluate(releasePreviewGate);
      await expect.poll(() => page.evaluate(() => (window as MergeWindow).__mergePreviewGate?.consumed)).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    },
    async expectAborted() {
      await expect.poll(() => page.evaluate(() => (window as MergeWindow).__mergePreviewGate?.aborted)).toBe(true);
    },
    async dispose() {
      await page.evaluate(releasePreviewGate);
    },
  };
}

export function mergeRouteGate() {
  let route: Route | undefined;
  let release!: () => void;
  let answered = false;
  let disposed = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cleanupError = { error: 'Merge fixture gate released during cleanup' };
  const reply = async (json: unknown, status = 200) => {
    expect(route, 'Wait for the gate request before replying').toBeDefined();
    expect(answered, 'A route gate replies once').toBe(false);
    answered = true;
    try {
      await route!.fulfill({ status, json });
    } finally {
      release();
    }
  };
  return {
    async handler(value: Route) {
      if (disposed) return value.fulfill({ status: 503, json: cleanupError });
      expect(route, 'A route gate owns one request').toBeUndefined();
      route = value;
      await held;
    },
    async received() {
      await expect.poll(() => Boolean(route)).toBe(true);
    },
    reply,
    async dispose() {
      disposed = true;
      try {
        if (route && !answered) await reply(cleanupError, 503);
      } finally {
        release();
      }
    },
  };
}
