import { expect, test } from '@playwright/test';

test('proxy keeps browser routes, auth and executor upgrades usable during DNS outage', async ({ page, context }) => {
  test.skip(process.env.RIVET_PROXY_DNS_FIXTURE !== '1', 'Owned by the isolated Docker DNS fixture');
  const base = process.env.PLAYWRIGHT_BASE_URL!;
  expect(new URL(base).hostname).toBe('127.0.0.1');
  await context.addCookies([{ name: 'fixture-auth', value: 'yes', url: base }]);
  const response = await page.goto('/dns-availability');
  expect(response?.status()).toBe(200);
  await page.locator('#run').click();
  await expect(page.locator('#output')).toContainText('browser body');
  await expect(page.locator('#output')).toContainText('api-1');
  const health = await page.request.get('/readyz');
  expect(health.status()).toBe(200);
  expect((await health.json()).identity).toBe('api-1');
  const socketOpened = await page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/ws/executor/internal`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('Executor upgrade timed out'));
        }, 5000);
        socket.onopen = () => {
          clearTimeout(timer);
          socket.close();
          resolve(true);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Executor upgrade failed'));
        };
      }),
  );
  expect(socketOpened).toBe(true);
  await context.clearCookies();
  const anonymous = await page.request.get('/api/echo');
  expect(await anonymous.text()).toBe('Fixture login');
});
