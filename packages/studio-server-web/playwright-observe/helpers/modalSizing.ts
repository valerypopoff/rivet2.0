import { expect, type Locator } from '@playwright/test';

// Measure in the owning document: editor iframe viewports differ from the dashboard.
export async function expectStudioModalSizing(modal: Locator) {
  await expect(modal).toBeVisible();
  const viewport = await modal.evaluate(() => window.innerWidth);
  const width = Math.min(960, viewport - 32);
  await expect(modal).toHaveCSS('width', `${width}px`);
  await expect(modal).toHaveCSS('min-width', `${Math.min(700, viewport - 32)}px`);
  await expect(modal).toHaveCSS('max-width', `${width}px`);
  await expect
    .poll(() =>
      modal.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.left >= 15 &&
          box.right <= window.innerWidth - 15 &&
          Math.abs(box.left - (window.innerWidth - box.width) / 2) < 1
        );
      }),
    )
    .toBe(true);
}

export async function expectStackedSettingsLayout(modal: Locator) {
  await expect
    .poll(() =>
      modal.evaluate((element) => {
        const sidebar = element.querySelector('.settings-modal-sidebar')!.getBoundingClientRect();
        const main = element.querySelector('main')!.getBoundingClientRect();
        return (
          main.top >= sidebar.bottom - 1 &&
          Math.abs(main.left - sidebar.left) < 1 &&
          Math.abs(main.width - sidebar.width) < 1
        );
      }),
    )
    .toBe(true);
}
