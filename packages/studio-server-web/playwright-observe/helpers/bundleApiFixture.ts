import { expect, test as base } from '@playwright/test';

/** Bundle scenarios own their API responses; unmatched requests never reach a real server. */
export const test = base.extend<{ bundleApiIsolation: void }>({
  bundleApiIsolation: [
    async ({ page, context }, use) => {
      const unexpected: string[] = [];
      await context.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (request.method() === 'GET') {
            if (pathname === '/api/app-settings/server-ui-session')
              return route.fulfill({ json: { mode: 'none', email: null } });
            if (pathname === '/api/app-settings/local-upgrade/setup')
              return route.fulfill({ json: { eligible: false } });
            if (pathname === '/api/app-settings/local-upgrade/status')
              return route.fulfill({ json: { available: false } });
            if (pathname === '/api/workflows/scheduled-runs/summary')
              return route.fulfill({ json: { enabledCount: 0 } });
          }
          if (request.method() !== 'GET' || /\/merge(?:\/preview)?$/.test(pathname))
            unexpected.push(`${request.method()} ${pathname}`);
          return route.fulfill({ status: 503, json: { error: 'No ambient bundle fixture API allowed' } });
        },
      );
      try {
        await use();
      } finally {
        await page.goto('about:blank');
        await page.unrouteAll({ behavior: 'wait' });
        expect(unexpected, 'Every bundle mutation or preview needs an explicit scenario response').toEqual([]);
      }
    },
    { auto: true },
  ],
});
