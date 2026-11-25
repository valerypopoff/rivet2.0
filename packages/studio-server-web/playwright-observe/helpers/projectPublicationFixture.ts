import { expect, test as base } from '@playwright/test';

/** Publication scenarios own their API responses and never use an ambient server. */
export const test = base.extend<{ publicationDashboard: void }>({
  publicationDashboard: [
    async ({ context }, use) => {
      const unexpectedMutations: string[] = [];
      await context.route(
        (url) => url.pathname.startsWith('/api/'),
        (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (request.method() !== 'GET') unexpectedMutations.push(`${request.method()} ${pathname}`);
          if (request.method() === 'GET') {
            if (pathname === '/api/app-settings/server-ui-session')
              return route.fulfill({ json: { mode: 'none', email: null } });
            if (pathname === '/api/app-settings/local-upgrade/setup')
              return route.fulfill({ json: { eligible: false } });
            if (pathname === '/api/workflows/scheduled-runs/summary')
              return route.fulfill({ json: { enabledCount: 0 } });
          }
          return route.fulfill({ status: 503, json: { error: 'Unavailable in the isolated publication fixture.' } });
        },
      );
      await use();
      expect(unexpectedMutations, 'Every mutation must have an explicit publication scenario response').toEqual([]);
    },
    { auto: true },
  ],
});
