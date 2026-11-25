import { expect, test as base, type Page, type Request, type Route } from '@playwright/test';
import type { ScheduledRun, ScheduledRunList } from '@valerypopoff/rivet-studio-server-shared/scheduled-run-types';
import type { WorkflowProjectItem } from '@valerypopoff/rivet-studio-server-shared/workflow-types';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './hostedEditorObserve';

export const scheduledPath = '/api/workflows/scheduled-runs';
export const fixtureProject: WorkflowProjectItem = {
  id: 'Jobs/fixture.rivet-project',
  projectMetadataId: 'scheduled-project',
  revisionId: 'fixture-revision',
  name: 'Fixture project',
  fileName: 'fixture.rivet-project',
  relativePath: 'Jobs/fixture.rivet-project',
  absolutePath: '/workflows/Jobs/fixture.rivet-project',
  updatedAt: '2026-11-25T00:00:00.000Z',
  settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
};

export function scheduledList(name = 'Original', enabled = true): ScheduledRunList {
  const schedule: ScheduledRun = {
    id: 'schedule',
    revision: 1,
    name,
    description: '',
    projectId: fixtureProject.projectMetadataId!,
    version: 'latest',
    enabled,
    timeZone: 'UTC',
    schedule: { kind: 'daily', time: '10:00' },
    record: true,
    timeoutMinutes: 60,
    missed: 'skip',
    nextAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
  return { schedules: [schedule], history: [] };
}

/** A gate owns its route until the test explicitly replies, including during teardown. */
export function scheduledRouteGate() {
  let release!: () => void;
  let received!: (route: Route) => void;
  const arrived = new Promise<Route>((resolve) => {
    received = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = 0;
  let answered = false;
  return {
    handler: async (route: Route) => {
      seen++;
      received(route);
      await released;
    },
    async reply(json: unknown, status = 200) {
      const route = await arrived;
      answered = true;
      try {
        await route.fulfill({ status, json });
      } finally {
        release();
      }
    },
    async received() {
      await expect.poll(() => seen).toBeGreaterThan(0);
    },
    get count() {
      return seen;
    },
    async dispose() {
      if (seen && !answered) await this.reply({ error: 'Fixture gate released during cleanup' }, 503);
      release();
    },
  };
}

export async function consumedScheduledReads(page: Page, count: number) {
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __scheduledReads?: number }).__scheduledReads ?? 0))
    .toBe(count);
}

/** Closed API ownership for lifecycle cases; the existing real-API journey stays independent. */
type ScheduledDashboard = {
  open(initial?: ScheduledRunList): Promise<void>;
  onList(route: Route): Promise<void>;
  reads: Request[];
  writes: Request[];
};

export const scheduledTest = base.extend<{ scheduledDashboard: ScheduledDashboard }>({
  scheduledDashboard: async ({ page, context }, use) => {
    const unexpected: string[] = [];
    const first = scheduledRouteGate();
    const reads: Request[] = [],
      writes: Request[] = [];
    const fixture: ScheduledDashboard = {
      reads,
      writes,
      async onList(route) {
        unexpected.push('Unowned scheduled list request');
        await route.fulfill({ status: 503, json: { error: 'Unowned list request' } });
      },
      async open(initial = scheduledList()) {
        await page.goto('/');
        await authenticateIfNeeded(page);
        await waitForDashboardReady(page);
        await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 60_000);
        await page.getByRole('button', { name: 'Scheduled runs', exact: true }).click();
        await first.received();
        // Finish the modal transition before starting the first poll's timer.
        await page.clock.runFor(500);
        await first.reply(initial);
        await consumedScheduledReads(page, 1);
        await expect(page.getByTestId('scheduled-runs-modal').getByText('Loading scheduled runs…')).toHaveCount(0);
      },
    };
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith(scheduledPath) && request.method() !== 'GET') writes.push(request);
    });
    await page.clock.install({ time: new Date('2026-11-25T00:00:00Z') });
    await page.addInitScript(() => {
      const owner = window as Window & { __scheduledReads?: number };
      owner.__scheduledReads = 0;
      const send = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const input = args[0];
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        const list = url.pathname === '/api/workflows/scheduled-runs' && (args[1]?.method ?? 'GET') === 'GET';
        let response: Response;
        try {
          response = await send(...args);
        } catch (error) {
          if (list) owner.__scheduledReads!++;
          throw error;
        }
        if (list) {
          const parse = response.json.bind(response);
          response.json = async () => {
            try {
              return await parse();
            } finally {
              owner.__scheduledReads!++;
            }
          };
        }
        return response;
      };
    });
    await context.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'GET') {
          if (pathname === scheduledPath) {
            reads.push(request);
            return reads.length === 1 ? first.handler(route) : fixture.onList(route);
          }
          if (pathname === '/api/workflows/tree')
            return route.fulfill({
              json: {
                root: '/workflows',
                folders: [],
                projects: [
                  {
                    ...fixtureProject,
                    id: 'Unreadable.rivet-project',
                    projectMetadataId: undefined,
                    name: 'Unreadable',
                  },
                  fixtureProject,
                ],
                sync: { epoch: 'scheduled-lifecycle', revision: 0 },
              },
            });
          if (pathname === '/api/app-settings/server-ui-session')
            return route.fulfill({ json: { mode: 'none', email: null } });
          if (pathname === '/api/app-settings/local-upgrade/setup') return route.fulfill({ json: { eligible: false } });
          if (pathname === '/api/app-settings/local-upgrade/status')
            return route.fulfill({ json: { available: false } });
          if (pathname === scheduledPath + '/summary') return route.fulfill({ json: { enabledCount: 0 } });
        }
        if (pathname.startsWith(scheduledPath) || request.method() !== 'GET')
          unexpected.push(`${request.method()} ${pathname}`);
        return route.fulfill({ status: 503, json: { error: 'No ambient fixture API allowed' } });
      },
    );
    await mockHostedEditorBootstrap(page);
    try {
      await use(fixture);
    } finally {
      await first.dispose();
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
      expect(unexpected, 'Every scheduled request must have an explicit scenario response').toEqual([]);
    }
  },
});
