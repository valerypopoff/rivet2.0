import { test } from '@playwright/test';
import { verifySizingJourney } from './fixtures/resource-sizing-journey';

test('sizing fixture loads the editor frontend and completes a published WebSocket action', async ({ page }) => {
  test.skip(process.env.RIVET_RUNTIME_PROVIDER_FIXTURE !== '1', 'Requires an explicitly owned staging fixture');
  await verifySizingJourney(page);
});
