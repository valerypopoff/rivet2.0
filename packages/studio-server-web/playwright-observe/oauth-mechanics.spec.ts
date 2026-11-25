import { expect, test, type Page } from '@playwright/test';
import { startOAuthHttpFixture, type OAuthStatus } from '../../studio-server-api/src/tests/helpers/oauth-http-fixture';

let fixture: Awaited<ReturnType<typeof startOAuthHttpFixture>>;
test.beforeAll(async () => {
  fixture = await startOAuthHttpFixture();
});
test.beforeEach(async () => {
  await fixture.command('reset');
});
test.afterAll(async () => {
  await fixture?.close();
});

async function signIn(page: Page, surface: 'UI' | 'app', email: string) {
  await page.getByRole('link', { name: `Sign in ${surface}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

test('UI OAuth denial and logout preserve the visitor session through real redirects and cookies', async ({ page }) => {
  await page.goto(`${fixture.baseUrl}/fixture/app`);
  await signIn(page, 'app', 'visitor@example.test');
  await expect(page.getByRole('heading', { name: 'App protected', exact: true })).toBeVisible();
  const visitorCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'rivet_web_app_oauth_session',
  );
  expect(visitorCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });

  await page.goto(`${fixture.baseUrl}/fixture/ui`);
  await signIn(page, 'UI', 'denied@example.test');
  await expect(page).toHaveURL(/auth_error=oauth_forbidden$/);
  await expect(page.getByRole('heading', { name: 'UI denied', exact: true })).toBeVisible();
  await signIn(page, 'UI', 'admin@example.test');
  await expect(page.getByRole('heading', { name: 'UI protected', exact: true })).toBeVisible();
  const signedIn = (await (await page.request.get(`${fixture.baseUrl}/fixture/status`)).json()) as OAuthStatus;
  expect(signedIn).toMatchObject({
    uiEmail: 'admin@example.test',
    uiAllowed: true,
    visitorEmail: 'visitor@example.test',
    visitorAllowed: true,
  });

  await page.context().addCookies([{ name: 'rivet_ui_token', value: 'obsolete-key-session', url: fixture.baseUrl }]);
  await page.getByRole('link', { name: 'Sign out UI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'UI denied', exact: true })).toBeVisible();
  const status = (await (await page.request.get(`${fixture.baseUrl}/fixture/status`)).json()) as OAuthStatus;
  expect(status).toMatchObject({
    uiEmail: null,
    uiAllowed: false,
    visitorEmail: 'visitor@example.test',
    visitorAllowed: true,
  });
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name === 'rivet_ui_token' || cookie.name === 'rivet_ui_oauth_session')).toBe(
    false,
  );
  expect(cookies.find((cookie) => cookie.name === 'rivet_web_app_oauth_session')?.value).toBe(visitorCookie?.value);
});

test('visitor OAuth allowlist and logout preserve the administrator session', async ({ page }) => {
  await page.goto(`${fixture.baseUrl}/fixture/ui`);
  await signIn(page, 'UI', 'admin@example.test');
  await expect(page.getByRole('heading', { name: 'UI protected', exact: true })).toBeVisible();
  await page.goto(`${fixture.baseUrl}/fixture/app`);
  await signIn(page, 'app', 'admin@example.test');
  await expect(page.getByRole('heading', { name: 'App denied', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in app', exact: true })).toHaveCount(0);
  const denied = (await (await page.request.get(`${fixture.baseUrl}/fixture/status`)).json()) as OAuthStatus;
  expect(denied).toMatchObject({ uiAllowed: true, visitorEmail: 'admin@example.test', visitorAllowed: false });
  await page.getByRole('link', { name: 'Sign out app', exact: true }).click();
  await signIn(page, 'app', 'visitor@example.test');
  await expect(page.getByRole('heading', { name: 'App protected', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Sign out app', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'App denied', exact: true })).toBeVisible();
  const status = (await (await page.request.get(`${fixture.baseUrl}/fixture/status`)).json()) as OAuthStatus;
  expect(status).toMatchObject({
    uiEmail: 'admin@example.test',
    uiAllowed: true,
    visitorEmail: null,
    visitorAllowed: false,
  });
});
