import { expect, test as base } from '@playwright/test';
import { mockHostedEditorBootstrap } from './hostedEditorObserve';

/** The upgrade suites exercise a built frontend without an ambient API or VM. */
export const test = base.extend<{ localUpgradeDashboard: void }>({
  localUpgradeDashboard: [
    async ({ page, context }, use) => {
      const unexpectedUpgradeRequests: string[] = [];
      const upgradePath = '/api/app-settings/local-upgrade';
      const readPaths = new Set([
        '',
        '/setup',
        '/inventory',
        '/fingerprint',
        '/project-reference',
        '/report',
        '/backup/download',
        '/backup/key',
        '/repair/download',
      ]);
      const writePaths = new Set(['/prepare', '/restart', '/preparation', '/pause', '/backup', '/copy', '/action']);
      context.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith(upgradePath)) return;
        const suffix = pathname.slice(upgradePath.length);
        if (
          !(request.method() === 'GET' && readPaths.has(suffix)) &&
          !(request.method() === 'POST' && writePaths.has(suffix))
        )
          unexpectedUpgradeRequests.push(`${request.method()} ${pathname}`);
      });
      await context.route(
        (url) => url.pathname.startsWith('/api/'),
        async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          if (pathname.startsWith('/api/app-settings/local-upgrade'))
            unexpectedUpgradeRequests.push(`${request.method()} ${pathname}`);
          if (request.method() === 'GET') {
            if (pathname === '/api/workflows/tree')
              return route.fulfill({
                json: {
                  root: '/workflows',
                  sync: { epoch: 'local-upgrade-fixture', revision: 0 },
                  folders: [],
                  projects: [],
                },
              });
            if (pathname === '/api/app-settings/server-ui-session')
              return route.fulfill({ json: { mode: 'none', email: null } });
            if (pathname === '/api/workflows/scheduled-runs/summary')
              return route.fulfill({ json: { enabledCount: 0 } });
          }
          return route.fulfill({ status: 503, json: { error: 'Unavailable in the isolated local-upgrade fixture.' } });
        },
      );
      await mockHostedEditorBootstrap(page);
      await page.route('**/?editor', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html><body>Paused editor fixture</body></html>' }),
      );
      await use();
      expect(unexpectedUpgradeRequests, 'Every upgrade request must have an explicit scenario response').toEqual([]);
    },
    { auto: true },
  ],
});
