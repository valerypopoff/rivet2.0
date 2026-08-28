import fs from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
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
