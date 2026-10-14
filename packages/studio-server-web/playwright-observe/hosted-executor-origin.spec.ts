import { expect, test } from '@playwright/test';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

const cases = [
  {
    name: 'HTTPS tunnel with rewritten localhost host',
    browserOrigin: 'https://rivet-tunnel.example.test',
    executorWsUrl: 'ws://localhost:8081/ws/executor/internal',
    isOverride: false,
    expectedUrl: 'wss://rivet-tunnel.example.test/ws/executor/internal',
  },
  {
    name: 'direct HTTP with a non-default port',
    browserOrigin: 'http://rivet-direct.example.test:8081',
    executorWsUrl: 'ws://rivet-direct.example.test:8081/ws/executor/internal',
    isOverride: false,
    expectedUrl: 'ws://rivet-direct.example.test:8081/ws/executor/internal',
  },
  {
    name: 'direct Kubernetes HTTPS',
    browserOrigin: 'https://rivet-kubernetes.example.test',
    executorWsUrl: 'wss://rivet-kubernetes.example.test/ws/executor/internal',
    isOverride: false,
    expectedUrl: 'wss://rivet-kubernetes.example.test/ws/executor/internal',
  },
  {
    name: 'Kubernetes TLS termination and internal service host',
    browserOrigin: 'https://rivet-kubernetes.example.test:8443',
    executorWsUrl: 'ws://rivet-backend.rivet.svc.cluster.local:8080/ws/executor/internal',
    isOverride: false,
    expectedUrl: 'wss://rivet-kubernetes.example.test:8443/ws/executor/internal',
  },
  {
    name: 'explicit separate executor override',
    browserOrigin: 'https://rivet-kubernetes.example.test',
    executorWsUrl: 'wss://executor.example.test:9443/custom/internal?route=editor',
    isOverride: true,
    expectedUrl: 'wss://executor.example.test:9443/custom/internal?route=editor',
  },
  {
    name: 'older Kubernetes server without override metadata',
    browserOrigin: 'https://rivet-kubernetes.example.test',
    executorWsUrl: 'ws://rivet-kubernetes.example.test/ws/executor/internal',
    isOverride: undefined,
    expectedUrl: 'wss://rivet-kubernetes.example.test/ws/executor/internal',
  },
] as const;

for (const scenario of cases) {
  test(`hosted Node executor origin: ${scenario.name}`, async ({ page, baseURL }) => {
    const { browserOrigin } = scenario;
    const sockets: string[] = [];
    await seedHostedEditorProject(page, {
      graphId: 'tunnel-executor-graph',
      projectId: 'tunnel-executor-project',
      projectPath: '/workflows/Tunnel executor.rivet-project',
      title: 'Tunnel executor',
      loaded: true,
    });
    await page.addInitScript(() => {
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'nodejs', recordExecutions: false }));
    });
    // Serve the real production frontend at an isolated public origin;
    // only the temporary preview server is contacted, never an ambient API.
    await page.route(`${browserOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({ status: 503, json: { error: 'No ambient API allowed' } });
      const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
      return route.fulfill({ response });
    });
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/config', (route) =>
      route.fulfill({
        json: {
          executorWsUrl: scenario.executorWsUrl,
          executorWsUrlIsOverride: scenario.isOverride,
          remoteDebuggerDefaultWs: '',
          remoteDebuggerDefaultWsIsOverride: false,
        },
      }),
    );
    await page.routeWebSocket(/.*/, (socket) => {
      sockets.push(socket.url());
    });
    try {
      await page.goto(`${browserOrigin}/?editor`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.node-canvas').first()).toBeVisible();
      await expect.poll(() => sockets.length).toBeGreaterThan(0);
      expect([...new Set(sockets)]).toEqual([scenario.expectedUrl]);
    } finally {
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
