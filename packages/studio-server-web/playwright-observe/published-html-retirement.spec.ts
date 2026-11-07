import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { createRetirementHttpConnections } from '../../studio-server-api/src/retirement-http-connections';
import { listenTestServer } from '../../studio-server-api/src/tests/helpers/http-server-harness';

test('a browser receives the complete published HTML while its server withdraws', async ({ page }) => {
  const html = `<!doctype html><title>Published app</title><pre>${'x'.repeat(8 * 1024 * 1024)}</pre><p id="complete">Complete published app</p>`;
  let withdrawing = false;
  const server = createServer((_req, res) => {
    connections.observeResponse(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    res.end(html);
    withdrawing = true;
    connections.closeIdleConnections();
  });
  const connections = createRetirementHttpConnections(server, () => withdrawing);
  const http = await listenTestServer(server);
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 10,
      downloadThroughput: 4 * 1024 * 1024,
      uploadThroughput: 4 * 1024 * 1024,
    });
    const response = await page.goto(http.baseUrl + '/apps/published', { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    expect(await response!.finished()).toBeNull();
    await expect(page.locator('#complete')).toHaveText('Complete published app');
    expect(await page.locator('pre').evaluate((element) => element.textContent?.length)).toBe(8 * 1024 * 1024);
  } finally {
    await http.close();
  }
});
