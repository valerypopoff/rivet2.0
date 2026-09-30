import { expect, test } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';

test('enabled local upgrade preserves browser authority and rejects unsafe origins without changing storage', async ({
  page,
}) => {
  test.skip(
    process.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED !== '1',
    'Requires an enabled, provisioned local instance.',
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  const status = async () => {
    const response = await page.request.get('/api/app-settings/local-upgrade');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.available).toBe(true);
    return { maintenance: body.maintenance, transition: body.transition };
  };
  const before = await status();
  // Intentionally malformed JSON can reach the parser but never an operator
  // action. Use browser fetch so Origin/Host are genuine, not a mocked route.
  const origin = new URL(page.url()).origin;
  const otherPort = new URL(origin);
  otherPort.port = otherPort.port === '1' ? '2' : '1';
  for (const action of ['pause', 'copy', 'action']) {
    const route = `/api/app-settings/local-upgrade/${action}`;
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Rivet-Migration-Intent': '1' },
        body: '{',
      });
      return response.status;
    }, route);
    expect(result, `${action}: same-origin requests must reach JSON validation, not fail origin authentication`).toBe(
      400,
    );
    for (const unsafeOrigin of ['http://unrelated.example.test', otherPort.origin]) {
      const hostile = await page.request.post(route, {
        headers: {
          Origin: unsafeOrigin,
          'X-Rivet-Migration-Intent': '1',
          'Content-Type': 'application/json',
          // Forwarded values must never substitute for the actual authority.
          'X-Forwarded-Host': new URL(unsafeOrigin).host,
        },
        data: '{',
      });
      expect(hostile.status(), `${action}: unsafe origin ${unsafeOrigin}`).toBe(403);
    }
    const missingIntent = await page.request.post(route, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: '{',
    });
    expect(missingIntent.status()).toBe(403);
  }
  expect(await status()).toEqual(before);
});
