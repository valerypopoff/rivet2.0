import { expect, type Page } from '@playwright/test';
import { verifyPublishedJourney } from './runtime-control-journey';

export async function verifySizingJourney(page: Page) {
  await verifyPublishedJourney(page);
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL!).origin;
  expect((await page.goto(new URL('/api/config', origin).href))?.status()).toBe(200);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(new URL('/', origin).href);
  expect(response?.status()).toBe(200);
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(errors).toEqual([]);
}
