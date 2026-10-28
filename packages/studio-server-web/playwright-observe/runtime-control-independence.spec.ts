import { expect, test } from '@playwright/test';
import { verifyPublishedJourney } from './fixtures/runtime-control-journey';

test('published OAuth, uncached web-app assets and actions work without either developer service', async ({ page }) => {
  test.skip(
    process.env.RIVET_RUNTIME_CONTROL_FIXTURE !== '1' && process.env.RIVET_RUNTIME_PROVIDER_FIXTURE !== '1',
    'Only an explicitly owned qualification fixture runs this test',
  );
  await verifyPublishedJourney(page);
  const developer = await page.request.get('/api/config');
  // Nginx may return 500 (no live upstream) or a gateway 5xx, depending on
  // which empty-Service/DNS observation this fresh proxy has made.
  expect(developer.status()).toBeGreaterThanOrEqual(500);
  expect(developer.status()).toBeLessThan(600);
});

test('published OAuth and actions still work after real local autoscaler drain and shrink', async ({ page }) => {
  test.skip(
    process.env.RIVET_RUNTIME_AUTOSCALER_FIXTURE !== '1',
    'Only the disposable local autoscaler fixture owns this test',
  );
  await verifyPublishedJourney(page);
  expect((await page.request.get('/api/config')).status()).toBe(200);
});
