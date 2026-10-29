import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type * as WebSocketModule from 'ws';
import { startAsyncWorkflowProcess } from '../../studio-server-api/src/tests/helpers/workflow-async-process';
import { listenTestServer } from '../../studio-server-api/src/tests/helpers/http-server-harness';
import { startRunCostStorage } from '../../studio-server-api/src/tests/helpers/run-cost-storage';
import {
  connectWebSocket,
  closeWebSocket,
  waitForWebSocketMessages,
  type WebSocketMessage,
} from '../../studio-server-api/src/tests/helpers/websocket-harness';
import { extractWebAppRevisionKey } from '../../studio-server-api/src/tests/helpers/workflow-web-app-fixtures';
import type { WorkflowRunStatisticsTarget } from '../../studio-server-shared/workflow-recording-types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const { createCostProviderServer } = createRequire(import.meta.url)(
  '../../studio-server-api/src/tests/helpers/cost-provider.cjs',
);
// Keep socket construction on the owning API's declared ws dependency.
const { WebSocket: DebuggerSocket } = createRequire(
  new URL('../../studio-server-api/src/ha-latest-relay.ts', import.meta.url),
)('ws') as typeof WebSocketModule;

test('real bundle costs survive recording, failed background work and a statistics UI reload', async ({ page }) => {
  test.setTimeout(180_000);
  const configured = process.env.RIVET_TEST_COST_PROVIDER_URL;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Cost fixture must remain local');
  }
  const provider = configured ? undefined : await listenTestServer(createCostProviderServer());
  const providerUrl = configured ?? provider!.baseUrl;
  const reset = await page.request.post(`${providerUrl}/__reset`);
  expect(reset.ok()).toBe(true);
  const storage = await startRunCostStorage().catch(async (error) => {
    await provider?.close();
    throw error;
  });
  const api = await startAsyncWorkflowProcess({ costProviderUrl: providerUrl, storage: storage.settings }).catch(
    async (error) => {
      await provider?.close();
      await storage.close();
      throw error;
    },
  );
  let retiringRoutes = false;
  try {
    const fixture = await api.command<{ workflowId: string; endpointName: string }>('seed-cost');
    const proxyToken = createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex');
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return route.fallback();
      const options = {
        url: `${api.baseUrl}${url.pathname}${url.search}`,
        headers: { ...request.headers(), 'x-rivet-proxy-auth': proxyToken },
      };
      if (request.headers().accept === 'text/event-stream') return route.continue(options);
      try {
        return await route.fulfill({ response: await route.fetch(options) });
      } catch (error) {
        // Playwright can retire an already accepted route during unrouteAll/page close.
        // Only contain that explicit teardown race; live proxy failures must still fail.
        if (
          retiringRoutes &&
          /Route is already handled|Target page, context or browser has been closed/.test(String(error))
        )
          return;
        throw error;
      }
    });
    const query = {
      target: { surface: 'endpoint', workflowId: fixture.workflowId },
      period: { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() },
      runKind: 'published',
      includeFailed: true,
      includeWarnings: true,
    };
    const statistics = async (target?: WorkflowRunStatisticsTarget) => {
      const response = await page.request.post(`${api.baseUrl}/api/workflows/run-statistics/query`, {
        headers: { 'x-rivet-proxy-auth': proxyToken },
        data: { ...query, target: target ?? query.target },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    for (const [index, model] of ['jev-1.14.0', 'unpriced-fixture', 'fixture-denied'].entries()) {
      const response = await page.request.post(`${api.baseUrl}/workflows/${fixture.endpointName}`, {
        data: { model, questions: { questionId: 'q', type: 'noul', instructions: 'Check fixture' }, state: '' },
      });
      expect(response.ok(), await response.text()).toBe(true);
      // A foreground response is not final accounting. Wait for the root recording.
      await expect
        .poll(async () => {
          const result = await statistics();
          return result.cost.completeCount + result.cost.partialCount + result.cost.unknownCount;
        })
        .toBe(index + 1);
    }
    const result = await statistics();
    expect(result.cost).toMatchObject({ completeCount: 1, partialCount: 2, unknownCount: 0 });
    expect(result.currentStatusCounts).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result.current.runCount).toBe(3);
    expect(result.cost.knownCostUsd).toBeCloseTo(0.004 * 3 + 0.000042 * 5, 12);
    expect(result.cost.averageCompleteCostUsd).toBeCloseTo(0.004 + 0.000042 * 3, 12);
    const requests = await (await page.request.get(`${providerUrl}/__requests`)).json();
    expect(requests.filter((request: { model: string }) => request.model === 'jev-1.14.0')).toHaveLength(5);
    expect(requests.filter((request: { model: string }) => request.model === 'unpriced-fixture')).toHaveLength(2);
    expect(requests.filter((request: { model: string }) => request.model === 'fixture-denied')).toHaveLength(1);
    expect(requests.filter((request: { kind?: string }) => request.kind === 'llm')).toHaveLength(3);
    expect(
      requests.filter((request: { kind?: string; stream?: boolean }) => request.kind === 'llm' && request.stream),
    ).toHaveLength(3);
    for (let pass = 0; pass < 2; pass++) {
      await page.goto('/');
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
      const modal = page.getByTestId('run-statistics-modal');
      const cost = modal.getByRole('region', { name: 'Cost statistics' });
      await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^2 runs, .+ to .+$/);
      await expect(cost).toContainText(/0[.,]008168/);
      await expect(cost).toContainText('Cost over time');
      await expect(cost.locator('.recharts-legend-item-text')).toHaveText([
        'Average per complete run',
        'Known subtotal',
      ]);
      await expect(cost.locator('.recharts-line')).toHaveCount(2);
      await modal.getByLabel('Include failed runs').check();
      await expect(modal.locator('.run-statistics-period-label')).toHaveText(/^3 runs, .+ to .+$/);
      await expect(cost).toContainText(/0[.,]01221/);
      await expect(
        modal.getByRole('region', { name: 'Run outcomes' }).locator('.failed .run-statistics-outcome-count'),
      ).toHaveText('1 run');
    }
    // Browsing/reloading presentation must never re-execute provider calls.
    expect(await (await page.request.get(`${providerUrl}/__requests`)).json()).toEqual(requests);

    // The same mixed-model bundle is also a real published web-app action.
    const html = await (await page.request.get(`${api.baseUrl}/apps/cost-app`)).text();
    const revisionKey = extractWebAppRevisionKey(html);
    const request = {
      model: 'jev-1.14.0',
      questions: { questionId: 'q', type: 'noul', instructions: 'Check fixture' },
      state: '',
    };
    const http = await page.request.post(`${api.baseUrl}/apps/cost-app/actions/run`, {
      data: { componentId: 'cost-run', revisionKey, state: { request } },
    });
    expect(http.ok(), await http.text()).toBe(true);
    const target: WorkflowRunStatisticsTarget = {
      surface: 'web_app',
      workflowId: fixture.workflowId,
      uiGraphId: 'cost-ui',
      componentId: 'cost-run',
    };
    await expect.poll(async () => (await statistics(target)).cost.completeCount).toBe(1);

    for (const cancelled of [false, true]) {
      const socket = await connectWebSocket(`${api.baseUrl.replace('http:', 'ws:')}/apps/cost-app/actions/ws`, {
        headers: { origin: api.baseUrl },
      });
      const parser = (raw: { toString(): string }) => {
        const data = JSON.parse(raw.toString());
        return { message: data.type as string, data };
      };
      try {
        const ready = waitForWebSocketMessages(socket, ['server.ready'], { parser });
        socket.send(JSON.stringify({ type: 'client.hello', protocolVersion: 1 }));
        await ready;
        const accepted = waitForWebSocketMessages(socket, ['action.accepted'], { parser });
        const terminal = waitForWebSocketMessages(socket, [cancelled ? 'action.cancelled' : 'action.completed'], {
          parser,
        });
        socket.send(
          JSON.stringify({
            type: 'action.start',
            requestId: `cost-${cancelled}`,
            revisionKey,
            componentId: 'cost-run',
            state: { request: { ...request, model: cancelled ? 'fixture-hold' : request.model } },
          }),
        );
        const acceptedMessages = await accepted;
        if (cancelled) {
          await expect
            .poll(async () => {
              const calls = await (await page.request.get(`${providerUrl}/__requests`)).json();
              return calls.filter((call: { model: string }) => call.model === 'fixture-hold').length;
            })
            .toBe(1);
          // The root LLM + Decision AI calls are already paid; the child is still in HTTP.
          socket.send(
            JSON.stringify({ type: 'action.cancel', runId: (acceptedMessages[0]!.data as { runId: string }).runId }),
          );
        }
        await terminal;
      } finally {
        closeWebSocket(socket);
      }
      await expect.poll(async () => (await statistics(target)).cost.runCount).toBe(cancelled ? 3 : 2);
    }
    const webCost = await statistics(target);
    expect(webCost.currentStatusCounts).toMatchObject({ succeeded: 2, failed: 1 });
    expect(webCost.cost).toMatchObject({ completeCount: 2, partialCount: 1, unknownCount: 0 });
    expect(webCost.cost.knownCostUsd).toBeCloseTo(3 * 0.004 + 7 * 0.000042, 12);
    expect(webCost.cost.averageCompleteCostUsd).toBeCloseTo(0.004 + 3 * 0.000042, 12);
    // The same real runtime/storage pipeline must respect authored prices,
    // including a custom child model and an LLM provider that reports a different USD cost.
    const priced = await api.command<{ workflowId: string; endpointName: string }>('seed-cost-priced');
    const pricedResponse = await page.request.post(`${api.baseUrl}/workflows/${priced.endpointName}`, {
      data: { ...request, model: 'unpriced-fixture' },
    });
    expect(pricedResponse.ok(), await pricedResponse.text()).toBe(true);
    const pricedTarget: WorkflowRunStatisticsTarget = { surface: 'endpoint', workflowId: priced.workflowId };
    await expect.poll(async () => (await statistics(pricedTarget)).cost.completeCount).toBe(1);
    const pricedCost = (await statistics(pricedTarget)).cost;
    expect(pricedCost.knownCostUsd).toBeCloseTo(0.009068, 12);
    expect(pricedCost).toMatchObject({ completeCount: 1, partialCount: 0, unknownCount: 0 });
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
    const pricedModal = page.getByTestId('run-statistics-modal');
    await expect(pricedModal.locator('.run-statistics-target-select__control')).toContainText('Cost root priced');
    await expect(pricedModal.locator('.run-statistics-period-label')).toHaveText(/^1 run, .+ to .+$/);
    await expect(pricedModal.getByRole('region', { name: 'Cost statistics' })).toContainText(/0[.,]009068/);

    // Exercise nonzero LLM + Decision AI accounting through the managed latest
    // route with shared observers. A zero-cost graph alone cannot prove that
    // fan-out/replay leaves physical provider attempts and persisted totals alone.
    const observers: WebSocketModule.WebSocket[] = [];
    let observations: Promise<WebSocketMessage[][]> | undefined;
    const observe = () => {
      const socket = new DebuggerSocket(`${api.baseUrl.replace('http:', 'ws:')}/ws/latest-debugger@cost_01`, {
        headers: { 'x-rivet-proxy-auth': proxyToken },
      });
      observers.push(socket);
      return socket;
    };
    const parseDebuggerFrame = (raw: WebSocketModule.RawData) => JSON.parse(raw.toString());
    const latestStatistics = async () => {
      const response = await page.request.post(`${api.baseUrl}/api/workflows/run-statistics/query`, {
        headers: { 'x-rivet-proxy-auth': proxyToken },
        data: { ...query, target: pricedTarget, runKind: 'latest' },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    try {
      await Promise.all([observe(), observe()].map((socket) => waitForWebSocketMessages(socket, ['latest-session'])));
      observations = Promise.all(
        observers.map((socket) =>
          waitForWebSocketMessages(socket, ['start', 'done', 'latest-settled'], { parser: parseDebuggerFrame }),
        ),
      );
      // Observe rejection immediately even if the HTTP request/assertion fails
      // before its normal await. Normal execution still requires all frames.
      void observations.catch(() => {});
      const callsBefore = await (await page.request.get(`${providerUrl}/__requests`)).json();
      const latestResponse = await page.request.post(`${api.baseUrl}/workflows-latest/${priced.endpointName}@cost_01`, {
        data: { ...request, model: 'unpriced-fixture' },
      });
      expect(latestResponse.ok(), await latestResponse.text()).toBe(true);
      const streams = await observations;
      const start = streams[0]!.find((frame) => frame.message === 'start');
      expect(start).toMatchObject({ rivetScope: { channel: 'cost_01', projectId: priced.workflowId } });
      expect(streams[1]!.find((frame) => frame.message === 'start')).toEqual(start);
      await expect.poll(async () => (await latestStatistics()).cost.runCount).toBe(1);
      const latestCost = (await latestStatistics()).cost;
      expect(latestCost).toMatchObject({ completeCount: 1, partialCount: 0, unknownCount: 0 });
      expect(latestCost.knownCostUsd).toBeCloseTo(0.009068, 12);
      const callsAfter = await (await page.request.get(`${providerUrl}/__requests`)).json();
      const newCalls = callsAfter.slice(callsBefore.length);
      expect(newCalls).toHaveLength(4); // One LLM and one Decision AI call in each of A, B and C.
      expect(newCalls.filter((call: { kind?: string }) => call.kind === 'llm')).toHaveLength(1);
      const replay = await waitForWebSocketMessages(observe(), ['start', 'done', 'latest-settled'], {
        parser: parseDebuggerFrame,
      });
      expect(replay.find((frame) => frame.message === 'start')).toEqual(start);
      expect((await latestStatistics()).cost).toEqual(latestCost);
      expect(await (await page.request.get(`${providerUrl}/__requests`)).json()).toEqual(callsAfter);
      expect((await statistics(pricedTarget)).cost, 'latest channels do not alter published totals').toEqual(
        pricedCost,
      );
    } finally {
      observers.forEach(closeWebSocket);
      await observations?.catch(() => {}); // Settle owned waiters without replacing the primary failure.
    }
  } finally {
    retiringRoutes = true;
    // Stop dashboard polling and settle intercepted requests before its API disappears.
    try {
      await page.unrouteAll({ behavior: 'wait' });
      await page.close();
    } finally {
      try {
        await api.close();
      } finally {
        try {
          await provider?.close();
        } finally {
          await storage.close();
        }
      }
    }
  }
});
