import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import http from 'node:http';
import {
  startAsyncWorkflowProcess,
  withAsyncDeadline,
} from '../../studio-server-api/src/tests/helpers/workflow-async-process';
import { listenTestServer } from '../../studio-server-api/src/tests/helpers/http-server-harness';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

test('an endpoint replies before async work finishes and its completed recording replays that work', async ({
  page,
}) => {
  test.setTimeout(90_000);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tail = await listenTestServer(
    http.createServer((_req, res) => {
      started();
      void gate.then(() => res.end('ASYNC RECORDING ACCEPTANCE COMPLETE'));
    }),
  );
  const api = await startAsyncWorkflowProcess().catch(async (error) => {
    await tail.close();
    throw error;
  });
  try {
    // Use the checkout's hosted UI with real API responses and artifacts from
    // the disposable server. No project or recording requests are mocked.
    const proxyToken = createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex');
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) {
        await route.fallback();
        return;
      }
      if (request.headers().accept === 'text/event-stream') {
        await route.continue({
          url: `${api.baseUrl}${url.pathname}${url.search}`,
          headers: { ...request.headers(), 'x-rivet-proxy-auth': proxyToken },
        });
        return;
      }
      const response = await route.fetch({
        url: `${api.baseUrl}${url.pathname}${url.search}`,
        headers: { ...request.headers(), 'x-rivet-proxy-auth': proxyToken },
      });
      await route.fulfill({ response });
    });
    const response = await page.request.post(`${api.baseUrl}/workflows/async-acceptance`, {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(tail.baseUrl),
      timeout: 5_000,
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toBe(tail.baseUrl);
    await withAsyncDeadline(ready, 'async request');
    expect((await api.command<{ active: number }>('snapshot')).active).toBe(1);
    expect((await api.command<{ runs: unknown[] }>('recordings')).runs).toHaveLength(0);
    release();
    await expect.poll(async () => (await api.command<{ runs: unknown[] }>('recordings')).runs.length).toBe(1);
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
    const modal = page.getByTestId('run-recordings-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.run-recordings-select__control').click();
    await page.locator('.run-recordings-select__option').filter({ hasText: 'Async acceptance' }).click();
    await expect(modal.locator('.run-recordings-run')).toHaveCount(1);
    await modal.locator('.run-recordings-run-open-button').click();
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    await expect(editor.getByRole('button', { name: 'Play Recording', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Play Recording', exact: true }).click();
    await expect(editor.locator('.node[data-nodeid="async-result"]')).toContainText(
      'ASYNC RECORDING ACCEPTANCE COMPLETE',
    );
  } finally {
    release();
    await tail.close();
    await api.close();
  }
});
