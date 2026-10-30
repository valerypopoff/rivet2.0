import { expect, test, type Page } from '@playwright/test';
import { RIVET_WEB_APP_CLIENT_JS } from '../../node/src/generated/webAppClient.generated';
import { verifyPublishedJourney } from './fixtures/runtime-control-journey';

type ResumeObservation = {
  armed: boolean;
  componentId: string;
  requestId?: string;
  runId?: string;
  starts: number;
  accepted: number;
  resumes: number;
  completions: number;
  dropped: boolean;
};
async function observeResume(page: Page, componentId: string) {
  await page.addInitScript((id) => {
    const state = window as unknown as { rivetContinuity: ResumeObservation };
    state.rivetContinuity = {
      armed: false,
      componentId: id,
      starts: 0,
      accepted: 0,
      resumes: 0,
      completions: 0,
      dropped: false,
    };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') return;
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          const p = state.rivetContinuity;
          if (message.requestId !== p.requestId || !p.requestId) return;
          if (message.type === 'action.accepted') {
            p.accepted++;
            p.runId = message.runId;
            if (p.armed && !p.dropped) {
              p.dropped = true;
              this.close(4000, 'Qualification proxy reconnect');
            }
          }
          if (message.type === 'action.completed') p.completions++;
        });
      }
      override send(data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') {
          try {
            const m = JSON.parse(data),
              p = state.rivetContinuity;
            if (m.type === 'action.start' && m.componentId === p.componentId) {
              p.starts++;
              p.requestId = m.requestId;
            }
            if (m.type === 'run.resume' && m.runId === p.runId) p.resumes++;
          } catch {
            /* Binary/storage traffic is outside this observation. */
          }
        }
        super.send(data);
      }
    };
  }, componentId);
}
const snapshot = (page: Page) =>
  page.evaluate(() => (window as unknown as { rivetContinuity: ResumeObservation }).rivetContinuity);
async function arm(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { rivetContinuity: ResumeObservation }).rivetContinuity.armed = true;
  });
}
async function assertResumed(page: Page, timeout = 120000) {
  await expect
    .poll(() => snapshot(page), { timeout })
    .toMatchObject({ dropped: true, starts: 1, accepted: 1, resumes: 1, completions: 1 });
}

test('generated web-app client resumes its accepted run after proxy socket loss without starting another action', async ({
  page,
}) => {
  let starts = 0,
    resumes = 0,
    requestId = '';
  await page.route('http://example.test/accepted-resume', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><div id="app"></div><script>window.__RIVET_WEB_APP__=${JSON.stringify({
        actionTransport: { type: 'websocket', socketPath: '/actions/ws' },
        revisionKey: 'fixture',
        initialState: {},
        uiGraph: {
          components: [{ id: 'run', type: 'button', label: 'Run', action: { type: 'runGraph', graphId: 'fixture' } }],
        },
      })};</script><script>${RIVET_WEB_APP_CLIENT_JS.replace(/<\/script/gi, '<\\/script')}</script>`,
    }),
  );
  await page.routeWebSocket('ws://example.test/actions/ws', (socket) => {
    socket.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'client.hello') socket.send(JSON.stringify({ type: 'server.ready', protocolVersion: 1 }));
      else if (m.type === 'action.start') {
        starts++;
        requestId = m.requestId;
        socket.send(JSON.stringify({ type: 'action.accepted', requestId, runId: 'accepted-run', sequence: 1 }));
        socket.close({ code: 1012, reason: 'Fixture proxy replacement' });
      } else if (m.type === 'run.resume') {
        resumes++;
        expect(m).toMatchObject({ runId: 'accepted-run', lastSequence: 1 });
        socket.send(
          JSON.stringify({
            type: 'action.completed',
            requestId,
            runId: 'accepted-run',
            sequence: 2,
            statePatch: {},
            storagePatch: {},
          }),
        );
      }
    });
  });
  await page.goto('http://example.test/accepted-resume');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => ({ starts, resumes }), { timeout: 10000 }).toEqual({ starts: 1, resumes: 1 });
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
});

test('published provider web app automatically resumes an accepted action through a replacement connection', async ({
  page,
}) => {
  test.skip(
    process.env.RIVET_REQUEST_CONTINUITY_FIXTURE !== '1' || process.env.RIVET_RUNTIME_PROVIDER_FIXTURE !== '1',
    'Requires the exact owned regional provider fixture',
  );
  await observeResume(page, 'release-gate-long-run-button');
  await verifyPublishedJourney(page);
  await arm(page);
  await page.getByRole('button', { name: 'Long run', exact: true }).click();
  await assertResumed(page);
});
