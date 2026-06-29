import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function readEmbeddedWebAppClientScript(): string {
  const sourcePath = path.resolve(process.cwd(), 'rivet/packages/node/src/webAppHandler.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const marker = 'const WEB_APP_CLIENT_JS = String.raw`';
  const start = source.indexOf(marker);

  if (start < 0) {
    throw new Error('Expected WEB_APP_CLIENT_JS marker in Rivet web app handler');
  }

  const scriptStart = start + marker.length;
  const scriptEnd = source.indexOf('`;', scriptStart);
  if (scriptEnd < 0) {
    throw new Error('Expected WEB_APP_CLIENT_JS template terminator');
  }

  return source.slice(scriptStart, scriptEnd);
}

function createWebAppHtml(clientScript: string): string {
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
      revisionKey: 'old-revision',
      uiGraph: {
        components: [
          { type: 'input', label: 'Prompt', stateKey: 'prompt' },
          { id: 'run-button', type: 'button', label: 'Run' }
        ]
      }
    };
  </script>
  <script>${clientScript.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;
}

test('Rivet web app client turns revision mismatches into a reload modal', async ({ page }) => {
  const clientScript = readEmbeddedWebAppClientScript();
  let htmlRequestCount = 0;
  let actionRequestBody: unknown;

  await page.route('http://example.test/app', async (route) => {
    htmlRequestCount += 1;
    await route.fulfill({
      body: createWebAppHtml(clientScript),
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
