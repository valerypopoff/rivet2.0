import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

const projectName = 'Node executor output pruning';
const projectPath = `/workflows/${projectName}.rivet-project`;
const mainGraphId = 'node-pruning-main';
const childGraphId = 'node-pruning-child';
const contents = `version: 4
data:
  metadata:
    id: node-pruning-project
    title: "${projectName}"
    description: ""
    mainGraphId: ${mainGraphId}
  graphs:
    ${mainGraphId}:
      metadata:
        id: ${mainGraphId}
        name: Main Graph
      nodes:
        '[node-pruning-optimized]:subGraph "Optimized caller"':
          data:
            graphId: ${childGraphId}
            skipUnusedOutputs: true
          visualData: 400/220/260/null//
          outgoingConnections:
            - wanted->"Optimized result" optimized-result/value
        '[optimized-result]:graphOutput "Optimized result"':
          data:
            id: optimized
            dataType: string
          visualData: 860/220/240/null//
        '[node-pruning-full]:subGraph "Full caller"':
          data:
            graphId: ${childGraphId}
            skipUnusedOutputs: false
          visualData: 400/620/260/null//
          outgoingConnections:
            - wanted->"Full result" full-result/value
        '[full-result]:graphOutput "Full result"':
          data:
            id: full
            dataType: string
          visualData: 860/620/240/null//
    ${childGraphId}:
      metadata:
        id: ${childGraphId}
        name: Child Graph
      nodes:
        '[wanted-text]:text "Wanted value"':
          data:
            text: wanted-result
          visualData: 400/220/260/null//
          outgoingConnections:
            - output->"Wanted output" wanted-output/value
        '[wanted-output]:graphOutput "Wanted output"':
          data:
            id: wanted
            dataType: string
          visualData: 860/220/240/null//
        '[unused-text]:text "Unused value"':
          data:
            text: unused-result
          visualData: 400/620/260/null//
          outgoingConnections:
            - output->"Unused output" unused-output/value
        '[unused-output]:graphOutput "Unused output"':
          data:
            id: unused
            dataType: string
          visualData: 860/620/240/null//
  plugins: []
  references: []
`;

type ObservedEvent = {
  message: string;
  graphId: string;
  graphRunId: string;
  nodeId?: string;
  callerNodeId?: string;
};

test('the real hosted Node executor omits unused child nodes only for the opted-in instance', async ({
  page,
}, testInfo) => {
  test.slow();
  const unexpectedMutations: string[] = [];
  const observed: ObservedEvent[] = [];
  const socketTargets = new Set<string>();
  // Observe the real transport, without replacing it or retaining project,
  // settings, credentials, node values, or unrelated execution payloads.
  page.on('websocket', (socket) => {
    const socketUrl = new URL(socket.url());
    socketTargets.add(`${socketUrl.origin}${socketUrl.pathname}`);
    socket.on('framereceived', ({ payload }) => {
      let incoming;
      try {
        incoming = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
      } catch {
        return;
      }
      if (incoming == null || typeof incoming !== 'object') return;
      if (!['graphStart', 'graphFinish', 'nodeStart', 'nodeFinish'].includes(incoming.message)) return;
      const execution = incoming.data?.execution;
      if (execution?.graphId !== childGraphId && execution?.graphId !== mainGraphId) return;
      observed.push({
        message: incoming.message,
        graphId: execution.graphId,
        graphRunId: execution.graphRunId,
        ...(incoming.data?.node?.id == null ? {} : { nodeId: incoming.data.node.id }),
        ...(execution.executor?.nodeId == null ? {} : { callerNodeId: execution.executor.nodeId }),
      });
    });
  });
  const project: WorkflowProjectItem = {
    id: 'node-pruning-project',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: projectPath,
    updatedAt: '2026-09-05T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  await page.addInitScript(() => {
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'nodejs', recordExecutions: false }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/workflows/tree' && request.method() === 'GET') {
      const tree: WorkflowTreeResponse = {
        root: '/workflows',
        sync: { epoch: 'node-pruning-fixture', revision: 0 },
        folders: [],
        projects: [project],
      };
      await route.fulfill({ json: tree });
    } else if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      unexpectedMutations.push(`${request.method()} ${path}`);
      await route.abort('blockedbyclient');
    } else {
      await route.fallback();
    }
  });

  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const row = page.locator('.project-row', { hasText: projectName });
    await expect(row).toBeEnabled({ timeout: 90_000 });
    await row.dblclick();
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const optimized = frame.locator('.node[data-nodeid="node-pruning-optimized"]');
    const full = frame.locator('.node[data-nodeid="node-pruning-full"]');
    await expect(optimized).toBeVisible({ timeout: 90_000 });
    await frame.locator('.more-menu').click();
    await expect(
      frame.getByRole('group', { name: 'Executor mode' }).getByRole('button', { name: 'Node', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await frame.locator('.more-menu').click();
    await frame.locator('.run-button button').first().click();
    await expect(optimized).toHaveClass(/success/);
    await expect(full).toHaveClass(/success/);

    const childRuns = observed.filter((event) => event.message === 'graphStart' && event.graphId === childGraphId);
    expect(childRuns).toHaveLength(2);
    const startedByCaller = (callerNodeId: string) => {
      const run = childRuns.find((event) => event.callerNodeId === callerNodeId);
      expect(run, `A real child invocation must belong to ${callerNodeId}`).toBeDefined();
      return observed
        .filter((event) => event.message === 'nodeStart' && event.graphRunId === run!.graphRunId)
        .map((event) => event.nodeId)
        .sort();
    };
    expect(startedByCaller('node-pruning-full')).toEqual([
      'unused-output',
      'unused-text',
      'wanted-output',
      'wanted-text',
    ]);
    expect(startedByCaller('node-pruning-optimized')).toEqual(['wanted-output', 'wanted-text']);
    await optimized.hover();
    await expect(optimized.locator('.node-output')).toContainText('wanted-result');
    await expect(optimized.locator('.node-output')).toContainText('Not ran');
    await expect(optimized.locator('.node-output')).not.toContainText('unused-result');
    await full.hover();
    await expect(full.locator('.node-output')).toContainText('unused-result');
    expect(unexpectedMutations).toEqual([]);
  } finally {
    await testInfo.attach('node-executor-event-identities.json', {
      body: JSON.stringify({ socketTargets: [...socketTargets], events: observed, unexpectedMutations }, null, 2),
      contentType: 'application/json',
    });
  }
});
