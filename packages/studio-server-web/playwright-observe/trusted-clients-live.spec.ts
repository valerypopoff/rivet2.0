import { expect, test } from '@playwright/test';
import { waitForDashboardReady } from './helpers/hostedEditorObserve';

test('trusted-client repair and validation through the real proxy and API', async ({ page }) => {
  test.skip(process.env.RIVET_TRUSTED_CLIENT_BROWSER_FIXTURE !== '1', 'Requires the disposable real API/proxy fixture');
  await expect.poll(async () => (await page.request.get('/')).status(), { timeout: 60_000 }).toBe(200);
  await page.goto('/');
  await expect(page.locator('#gate-key')).toBeVisible();
  // This fixture has a fixed, non-secret key. Never send the developer's .env
  // credential (the observe runner intentionally loads that file).
  await page.locator('#gate-key').fill('fixture-key');
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('#gate-key')).toHaveCount(0);
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'App settings' }).click();
  const modal = page.getByTestId('app-settings-modal');
  const clients = modal.getByLabel('Trusted clients', { exact: true });
  const save = modal.locator('.app-settings-panel-region > .app-settings-actions-row').getByRole('button', { name: 'Save' });
  await expect(modal.getByRole('alert')).toContainText('Bypass is disabled');
  await expect(clients).toHaveValue('');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(modal.getByRole('alert')).toHaveCount(0);
  await expect(modal.locator('.project-settings-success')).toHaveText('Saved.');
  await clients.fill('localhost');
  await expect(clients).toHaveValue('localhost');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(modal).toContainText('Enter an IP address or CIDR network');
  await clients.fill('192.0.2.15');
  await expect(clients).toHaveValue('192.0.2.15');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(modal.locator('.project-settings-success')).toHaveText('Saved.');
  const response = await page.request.get('/api/app-settings/trusted-clients/current-request');
  expect(response.status()).toBe(200);
  const identity = await response.json();
  expect(identity.clientAddress).toBeTruthy();
  await expect(modal).toContainText('Verified address for this connection: ' + identity.clientAddress);
  const settings = await page.request.get('/api/app-settings/trusted-clients');
  expect((await settings.json()).trustedClients).toEqual(['192.0.2.15']);
  await page.screenshot({ path: '../../artifacts/playwright/trusted-clients-repaired.png' });
});
