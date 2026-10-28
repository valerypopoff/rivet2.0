import { expect, type Page } from '@playwright/test';

export async function verifyPublishedJourney(page: Page) {
  const base = new URL(process.env.PLAYWRIGHT_BASE_URL!);
  if (process.env.RIVET_RUNTIME_PROVIDER_FIXTURE === '1') {
    expect(base.origin).toBe(process.env.RIVET_RUNTIME_PROVIDER_ORIGIN);
    expect(base.protocol).toBe('https:');
    const cookie = process.env.RIVET_RUNTIME_PROVIDER_UI_COOKIE!;
    expect(cookie).toMatch(/^rivet_ui_token=[^;\s]+$/);
    await page.context().addCookies([
      {
        name: 'rivet_ui_token',
        value: cookie.slice('rivet_ui_token='.length),
        url: base.origin,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  } else expect(base.hostname).toBe('127.0.0.1');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const state = window as unknown as { rivetQualificationCompletions: number };
    state.rivetQualificationCompletions = 0;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          try {
            if (JSON.parse(event.data).type === 'action.completed') state.rivetQualificationCompletions++;
          } catch {
            /* not an action message */
          }
        });
      }
    };
  });
  const health = (await page.goto(new URL('/readyz', base.origin).href))!;
  expect(health.status()).toBe(200);
  expect((await health.json()).profile).toBe('execution');
  await page.goto(new URL('/apps/release-gate-web-app?auth_action=login', base.origin).href);
  await page.getByLabel('Email').fill('runtime-control@example.test');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { rivetQualificationCompletions: number }).rivetQualificationCompletions,
      ),
    )
    .toBe(1);
  expect(errors).toEqual([]);
}
