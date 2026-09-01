import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { UiGraph } from '../../core/src/model/UiGraph';
import { getUiGraphChatStorageKey } from '../../core/src/model/UiGraphBrowserRuntime';
import { RIVET_MARKDOWN_SANITIZER_POLICY } from '../../core/src/model/MarkdownSanitizationPolicy';
import { RIVET_WEB_APP_CLIENT_JS } from '../../node/src/generated/webAppClient.generated';

const requireFromStudioServerWeb = createRequire(import.meta.url);

function readRivetWebAppBrowserAsset(packagePath: string): string {
  return fs.readFileSync(requireFromStudioServerWeb.resolve(packagePath), 'utf8');
}

function createWebAppHtml(clientScript: string, extraBodyHtml = ''): string {
  const markedScript = readRivetWebAppBrowserAsset('marked/marked.min.js');
  const domPurifyScript = readRivetWebAppBrowserAsset('dompurify/dist/purify.min.js');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Stale web app test</title>
</head>
<body>
  <div id="app" class="rivet-web-app-root"></div>
  <script>
    window.__RIVET_WEB_APP__ = {
      actionPath: 'http://example.test/actions/run',
      initialState: { prompt: 'initial value' },
      markdownSanitizerPolicy: ${JSON.stringify(RIVET_MARKDOWN_SANITIZER_POLICY)},
      revisionKey: 'old-revision',
      uiGraph: {
        components: [
          { type: 'markdown', markdown: '**Rendered markdown**' },
          { type: 'input', label: 'Prompt', stateKey: 'prompt' },
          {
            id: 'run-button',
            type: 'button',
            label: 'Run',
            action: {
              graphId: 'run-graph',
              inputMappings: [{ inputKey: 'prompt', stateKey: 'prompt' }],
            }
          }
        ]
      }
    };
  </script>
  <script>${markedScript.replace(/<\/script/gi, '<\\/script')}</script>
  <script>${domPurifyScript.replace(/<\/script/gi, '<\\/script')}</script>
  <script>${clientScript.replace(/<\/script/gi, '<\\/script')}</script>
  ${extraBodyHtml}
</body>
</html>`;
}

const CHAT_COMPONENT_ID = 'playwright-chat';
const CHAT_UI_GRAPH = {
  components: [{ action: { type: 'runGraph' }, id: CHAT_COMPONENT_ID, title: 'Persisted chat', type: 'chat' }],
  id: 'playwright-indexeddb-chat',
} as unknown as UiGraph;

function createChatWebAppHtml(clientScript: string): string {
  const markedScript = readRivetWebAppBrowserAsset('marked/marked.min.js');
  const domPurifyScript = readRivetWebAppBrowserAsset('dompurify/dist/purify.min.js');
  const config = {
    actionPath: 'http://example.test/actions/chat',
    initialState: {},
    markdownSanitizerPolicy: RIVET_MARKDOWN_SANITIZER_POLICY,
    revisionKey: 'indexeddb-revision',
    uiGraph: CHAT_UI_GRAPH,
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>IndexedDB chat storage test</title>
</head>
<body>
  <div id="app" class="rivet-web-app-root"></div>
  <script>
    window.__RIVET_WEB_APP__ = ${JSON.stringify(config)};
  </script>
  <script>${markedScript.replace(/<\/script/gi, '<\\/script')}</script>
  <script>${domPurifyScript.replace(/<\/script/gi, '<\\/script')}</script>
  <script>${clientScript.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;
}

function getLegacyChatState(): Record<string, unknown> {
  return {
    [`__rivet_chat_${CHAT_COMPONENT_ID}_draft`]: 'Migrated draft',
    [`__rivet_chat_${CHAT_COMPONENT_ID}_messages`]: [
      { content: 'Migrated question', role: 'user', timestamp: '2026-08-31T12:00:00.000Z' },
      { content: 'Migrated answer', role: 'assistant', timestamp: '2026-08-31T12:00:01.000Z' },
    ],
    [`__rivet_chat_${CHAT_COMPONENT_ID}_pins`]: [1],
  };
}

function createLogoutControlHtml(): string {
  return `<style>
  .rivet-web-app-auth-logout { position: fixed; top: 12px; right: 12px; z-index: 2147483647; display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; background: rgb(20 20 24 / 0.82); color: #f4f4f5; }
</style>
<a class="rivet-web-app-auth-logout" href="/apps/auth/logout?return_to=%2Fapps%2Ftest&amp;select_account=1">Sign out</a>`;
}

test('Rivet web app client turns revision mismatches into a reload modal', async ({ page }) => {
  let htmlRequestCount = 0;
  let actionRequestBody: unknown;

  await page.route('http://example.test/app', async (route) => {
    htmlRequestCount += 1;
    await route.fulfill({
      body: createWebAppHtml(RIVET_WEB_APP_CLIENT_JS),
      contentType: 'text/html',
      status: 200,
    });
  });

  await page.route('http://example.test/actions/run', async (route) => {
    actionRequestBody = route.request().postDataJSON();
    await route.fulfill({
      body: JSON.stringify({
        error: 'Rivet web app revision mismatch.',
        code: 'revision_mismatch',
      }),
      contentType: 'application/json',
      status: 409,
    });
  });

  await page.goto('http://example.test/app');
  await page.getByLabel('Prompt').fill('preserved value');
  await page.getByRole('button', { name: 'Run' }).click();

  const modal = page.getByRole('dialog', { name: 'This app was updated. Reload to continue.' });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByLabel('Prompt')).toHaveValue('preserved value');
  expect(actionRequestBody).toMatchObject({
    componentId: 'run-button',
    revisionKey: 'old-revision',
    state: {
      prompt: 'preserved value',
    },
  });

  await modal.getByRole('button', { name: 'Reload' }).click();
  await expect.poll(() => htmlRequestCount).toBe(2);
});

test('Rivet web app client keeps the wrapper OAuth logout control visible', async ({ page }) => {
  await page.route('http://example.test/oauth-app', async (route) => {
    await route.fulfill({
      body: createWebAppHtml(RIVET_WEB_APP_CLIENT_JS, createLogoutControlHtml()),
      contentType: 'text/html',
      status: 200,
    });
  });

  await page.goto('http://example.test/oauth-app');

  const logout = page.getByRole('link', { name: 'Sign out' });
  await expect(logout).toBeVisible();
  await expect(logout).toHaveAttribute('href', '/apps/auth/logout?return_to=%2Fapps%2Ftest&select_account=1');
  await expect(page.locator('.rivet-web-app-markdown strong')).toHaveText('Rendered markdown');
});

test('Rivet web app migrates legacy Chat state to IndexedDB and synchronizes it across tabs', async ({
  context,
  page,
}) => {
  const appUrl = 'http://example.test/indexeddb-chat';
  const legacyKey = getUiGraphChatStorageKey(CHAT_UI_GRAPH, {
    origin: 'http://example.test',
    pathname: '/indexeddb-chat',
  });
  expect(legacyKey).toBeTruthy();

  await context.addInitScript(
    ({ key, seedMarker, value }) => {
      if (localStorage.getItem(seedMarker) === 'complete') return;
      localStorage.setItem(key, value);
      localStorage.setItem(seedMarker, 'complete');
    },
    {
      key: legacyKey!,
      seedMarker: 'rivet-playwright-indexeddb-migration-seeded',
      value: JSON.stringify(getLegacyChatState()),
    },
  );
  await context.route(appUrl, async (route) => {
    await route.fulfill({ body: createChatWebAppHtml(RIVET_WEB_APP_CLIENT_JS), contentType: 'text/html', status: 200 });
  });

  await page.goto(appUrl);
  const firstComposer = page.locator('.rivet-web-app-chat-composer textarea');
  await expect(firstComposer).toHaveValue('Migrated draft');
  await expect(page.getByText('Migrated question', { exact: true })).toBeVisible();
  await expect(page.getByText('Migrated answer', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show 1 pinned response' }).click();
  await expect(page.locator('.rivet-web-app-chat-pin')).toHaveCount(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey!)).toBe(JSON.stringify(getLegacyChatState()));

  await page.evaluate((key) => localStorage.removeItem(key), legacyKey!);
  await page.reload();
  await expect(page.locator('.rivet-web-app-chat-composer textarea')).toHaveValue('Migrated draft');
  await expect(page.getByText('Migrated answer', { exact: true })).toBeVisible();

  const secondPage = await context.newPage();
  await secondPage.goto(appUrl);
  const secondComposer = secondPage.locator('.rivet-web-app-chat-composer textarea');
  await expect(secondComposer).toHaveValue('Migrated draft');

  await page.locator('.rivet-web-app-chat-composer textarea').fill('Updated in the first tab');
  await expect(secondComposer).toHaveValue('Updated in the first tab');
  await secondPage.close();
});

test('Rivet web app warns when IndexedDB is unavailable', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    });
    await context.route('http://example.test/indexeddb-unavailable', async (route) => {
      await route.fulfill({
        body: createChatWebAppHtml(RIVET_WEB_APP_CLIENT_JS),
        contentType: 'text/html',
        status: 200,
      });
    });

    const page = await context.newPage();
    await page.goto('http://example.test/indexeddb-unavailable');
    await expect(page.getByRole('alert')).toContainText(
      'Saved browser data is unavailable. Changes will use limited legacy storage for this page.',
    );
  } finally {
    await context.close();
  }
});
