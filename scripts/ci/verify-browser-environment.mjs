import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const browserCiEndpoint = 'ws://127.0.0.1:3100/';

/** Fail before the suite if a lockfile upgrade no longer matches the CI image.
 * Never download a replacement browser or silently fall back to a host binary. */
export async function verifyBrowserEnvironment({ expectedVersion, actualVersion, endpoint, chromium }) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '') || actualVersion !== expectedVersion)
    throw Error('Playwright package/image version mismatch; update and verify the pinned CI image together.');
  if (endpoint !== browserCiEndpoint) throw Error('Browser setup must use the exact loopback CI endpoint.');
  const browser = await chromium.connect(endpoint, { timeout: 15_000, exposeNetwork: '<loopback>' });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent('<main>Rivet browser environment ready</main>', { timeout: 10_000 });
    if ((await page.locator('main').innerText({ timeout: 10_000 })) !== 'Rivet browser environment ready')
      throw Error('The preinstalled browser did not render the smoke page.');
    return { playwright: actualVersion, chromium: browser.version(), passed: true };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const require = createRequire(new URL('../../packages/studio-server-web/package.json', import.meta.url));
    console.log(
      JSON.stringify(
        await verifyBrowserEnvironment({
          expectedVersion: process.env.RIVET_CI_PLAYWRIGHT_VERSION,
          actualVersion: require('@playwright/test/package.json').version,
          endpoint: process.env.PW_TEST_CONNECT_WS_ENDPOINT,
          chromium: require('@playwright/test').chromium,
        }),
      ),
    );
  } catch (error) {
    console.error(`[browser-setup] ${error.message}`);
    process.exitCode = 1;
  }
}
