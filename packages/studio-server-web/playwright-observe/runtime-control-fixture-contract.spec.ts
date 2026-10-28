import { expect, test } from '@playwright/test';
import { verifyPublishedJourney } from './fixtures/runtime-control-journey';

// Browser-only fixture contract. No DNS, cloud API or application writes: the
// actual provider journey remains a separately approved GKE qualification.
test('provider fixture uses its exact origin, UI cookie and completed action rather than a bypassed login', async ({
  page,
}) => {
  const keys = [
    'PLAYWRIGHT_BASE_URL',
    'RIVET_RUNTIME_PROVIDER_FIXTURE',
    'RIVET_RUNTIME_PROVIDER_ORIGIN',
    'RIVET_RUNTIME_PROVIDER_UI_COOKIE',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const origin = 'https://rivet-q-123-1.qualification.example.test';
  try {
    Object.assign(process.env, {
      PLAYWRIGHT_BASE_URL: origin,
      RIVET_RUNTIME_PROVIDER_FIXTURE: '1',
      RIVET_RUNTIME_PROVIDER_ORIGIN: origin,
      RIVET_RUNTIME_PROVIDER_UI_COOKIE: 'rivet_ui_token=fixture-only',
    });
    await page.route(`${origin}/**`, async (route) => {
      expect(route.request().headers().cookie).toContain('rivet_ui_token=fixture-only');
      if (route.request().url().includes('/readyz')) return route.fulfill({ json: { profile: 'execution' } });
      return route.fulfill({
        contentType: 'text/html',
        body: `<label>Email<input id="email"></label><button id="continue">Continue</button><button id="run" hidden>Run</button>
        <script>document.getElementById('continue').onclick=()=>{document.getElementById('run').hidden=false};
        document.getElementById('run').onclick=()=>{const s=new WebSocket('wss://rivet-q-123-1.qualification.example.test/ws/action');s.onopen=()=>s.send('run')};</script>`,
      });
    });
    await page.routeWebSocket(`wss://rivet-q-123-1.qualification.example.test/ws/action`, (socket) => {
      socket.onMessage((message) => {
        expect(message).toBe('run');
        socket.send(JSON.stringify({ type: 'action.completed' }));
      });
    });
    await verifyPublishedJourney(page);
  } finally {
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  }
});
