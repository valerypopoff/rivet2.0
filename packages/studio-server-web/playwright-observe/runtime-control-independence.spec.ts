import { expect, test } from '@playwright/test';

test('published OAuth, uncached web-app assets and actions work without either developer service', async ({ page }) => {
  test.skip(process.env.RIVET_RUNTIME_CONTROL_FIXTURE !== '1', 'Only the disposable local HA fixture owns this test');
  expect(new URL(process.env.PLAYWRIGHT_BASE_URL!).hostname).toBe('127.0.0.1');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const completed: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString();
      try {
        if (JSON.parse(text).type === 'action.completed') completed.push(text);
      } catch {
        /* not an action event */
      }
    }),
  );
  const health = await page.request.get('/readyz');
  expect(health.status()).toBe(200);
  expect((await health.json()).profile).toBe('execution');
  await page.goto('/apps/release-gate-web-app?auth_action=login');
  await page.getByLabel('Email').fill('runtime-control@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => completed.length).toBe(1);
  expect(errors).toEqual([]);
  const developer = await page.request.get('/api/config');
  // Nginx may return 500 (no live upstream) or a gateway 5xx, depending on
  // which empty-Service/DNS observation this fresh proxy has made.
  expect(developer.status()).toBeGreaterThanOrEqual(500);
  expect(developer.status()).toBeLessThan(600);
});
