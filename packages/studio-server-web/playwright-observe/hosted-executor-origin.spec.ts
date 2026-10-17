import { expect, test } from '@playwright/test';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';
import { ExecutionRecorder } from '@valerypopoff/rivet2-core';

test('HA reconnect persists one complete editor recording without resubmitting the run', async ({ page }) => {
  const projectId = 'ha-recording-project';
  const graph = { metadata: { id: 'ha-recording-graph', name: 'Main Graph' }, nodes: [], connections: [] };
  const project = { metadata: { id: projectId, title: 'HA recording' }, graphs: { [graph.metadata.id]: graph }, plugins: [], references: [] };
  await seedHostedEditorProject(page, {
    projectId, graphId: graph.metadata.id, title: 'HA recording', loaded: true,
    projectPath: '/workflows/ha-recording.rivet-project',
  });
  await page.addInitScript(() => localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'nodejs', recordExecutions: true })));
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/config', route => route.fulfill({ json: {
    executorWsUrl: 'ws://rivet-internal/ws/executor/owner/recording-owner', executorWsUrlIsOverride: false,
    remoteDebuggerDefaultWs: '',
  } }));
  const uploads: Array<{ recordingSerialized: string; status: string }> = [];
  const unavailable: unknown[] = [];
  await page.route('**/api/workflows/local-editor-recordings**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { supported: true } });
    if (new URL(route.request().url()).pathname.endsWith('/outcome')) {
      unavailable.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    }
    uploads.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { availability: 'available', recordingId: 'reconnected-recording' } });
  });
  let connections = 0, runCommands = 0, requestId: string | undefined;
  const start = () => ({ message: 'start', requestId, rivetSequence: 1,
    data: { project, startGraph: graph, contextValues: {}, inputs: {} } });
  await page.routeWebSocket('**/ws/executor/owner/**', socket => {
    connections++;
    socket.send(JSON.stringify({ message: 'executor-session', data: { protocol: 1, capability: 'r'.repeat(43), resumed: connections > 1 } }));
    if (connections > 1) socket.send(JSON.stringify(start()));
    socket.send(JSON.stringify({ message: 'executor-session-ready', data: { protocol: 1, resumed: connections > 1 } }));
    if (connections > 1) {
      socket.send(JSON.stringify({ message: 'done', requestId, rivetSequence: 2, data: { results: {} } }));
      return;
    }
    socket.onMessage(message => {
      if (typeof message !== 'string' || !message.startsWith('{')) return;
      const payload = JSON.parse(message);
      if (payload.type !== 'run') return;
      runCommands++;
      requestId = payload.data.requestId;
      socket.send(JSON.stringify(start()));
      socket.close({ code: 1012, reason: 'simulated proxy replacement' });
    });
  });
  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.node-canvas').first()).toBeVisible();
  await expect(page.locator('.run-button button').first()).toBeEnabled();
  await page.locator('.run-button button').first().click();
  await expect.poll(() => uploads.length).toBe(1);
  expect(connections).toBe(2);
  expect(runCommands).toBe(1);
  expect(unavailable).toEqual([]);
  expect(uploads[0]!.status).toBe('succeeded');
  const recorder = ExecutionRecorder.deserializeFromString(uploads[0]!.recordingSerialized);
  expect(recorder.events.map(event => event.type)).toEqual(['start', 'done']);
  await page.goto('about:blank');
});

const cases = [
  {
    name: 'HA owner route preserves pod incarnation behind Kubernetes TLS termination',
    browserOrigin: 'https://rivet-kubernetes.example.test',
    executorWsUrl:
      'ws://rivet-api.rivet.svc.cluster.local:3001/ws/executor/owner/rivet-backend-1/11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    isOverride: false,
    expectedUrl:
      'wss://rivet-kubernetes.example.test/ws/executor/owner/rivet-backend-1/11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
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
    let selectedExecutorUrl = scenario.executorWsUrl;
    let originalOwner: { send(payload: string): void } | undefined;
    let runCommands = 0;
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
          executorWsUrl: selectedExecutorUrl,
          executorWsUrlIsOverride: scenario.isOverride,
          remoteDebuggerDefaultWs: '',
          remoteDebuggerDefaultWsIsOverride: false,
        },
      }),
    );
    await page.routeWebSocket(/.*/, (socket) => {
      // Source-based verification also opens Vite's root HMR socket. It is not
      // an executor connection; keep every other unexpected URL in the assertion.
      const url = new URL(socket.url());
      if (url.pathname === '/' && url.searchParams.has('token')) return;
      sockets.push(socket.url());
      if (socket.url().includes('/ws/executor/owner/')) {
        originalOwner ??= socket;
        socket.onMessage(message => {
          if (typeof message === 'string' && message.startsWith('{') && JSON.parse(message).type === 'run') runCommands++;
        });
        socket.send(JSON.stringify({ message: 'executor-session', data: { protocol: 1, capability: (sockets.length === 1 ? 'a' : 'b').repeat(43) } }));
        socket.send(JSON.stringify({ message: 'executor-session-ready', data: { protocol: 1 } }));
      }
    });
    try {
      await page.goto(`${browserOrigin}/?editor`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.node-canvas').first()).toBeVisible();
      await expect.poll(() => sockets.length).toBeGreaterThan(0);
      expect([...new Set(sockets)]).toEqual([scenario.expectedUrl]);
      if (originalOwner) {
        selectedExecutorUrl = scenario.executorWsUrl.replace('/rivet-backend-1/', '/rivet-backend-2/');
        originalOwner.send(JSON.stringify({ message: 'executor-owner-retiring', data: { protocol: 1 }, rivetSequence: 1 }));
        await expect.poll(() => [...new Set(sockets)]).toEqual([
          scenario.expectedUrl, scenario.expectedUrl.replace('/rivet-backend-1/', '/rivet-backend-2/'),
        ]);
        expect(runCommands).toBe(0);
      }
    } finally {
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}
