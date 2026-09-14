import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';

import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

import {
  accountingGraph,
  accountingProviderResponse,
  accountingToolGraph,
} from '../../evaluations/test/fixtures/accountingGraph';

type EditorRoot = Page | FrameLocator;
type ExecutorMode = 'browser' | 'nodejs';

test('Browser evaluation retains provider-call metrics and full attempt evidence after reopening the run', async ({
  page,
}, testInfo) => {
  const provider = await startProvider({ host: '127.0.0.1', outcome: 'success' });
  const suiteName = uniqueFixtureName('Browser provider metrics', testInfo);
  try {
    await runAndVerifyEvaluation({
      executor: 'browser',
      page,
      projectId: 'browser-evaluation-metrics-project',
      projectPath: '/workflows/Browser evaluation metrics.rivet-project',
      providerBaseUrl: `http://127.0.0.1:${provider.port}/v1`,
      suiteName,
    });

    expect(provider.requests).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const editor = await getEditorRoot(page);
    await expect(editor.locator('.node[data-nodeid="llm"]')).toBeVisible({ timeout: 60_000 });
    await openPersistedTrial(editor, suiteName, { failure: false });
  } finally {
    await closeProvider(provider.server);
  }
});

test('the hosted Node executor retains partial provider evidence after an unsuccessful evaluation', async ({
  page,
}, testInfo) => {
  // The development compose stack maps this hostname to the Docker host. It
  // is the supported way for the real executor container to reach a provider
  // fixture started by the observable-test process.
  const provider = await startProvider({ host: '0.0.0.0', outcome: 'failure' });
  const suiteName = uniqueFixtureName('Node provider metrics', testInfo);
  try {
    await runAndVerifyEvaluation({
      executor: 'nodejs',
      page,
      projectId: 'node-evaluation-metrics-project',
      projectPath: '/workflows/Node evaluation metrics.rivet-project',
      providerBaseUrl: `http://host.docker.internal:${provider.port}/v1`,
      suiteName,
    });

    expect(provider.requests).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const editor = await getEditorRoot(page);
    await expect(editor.locator('.node[data-nodeid="llm"]')).toBeVisible({ timeout: 60_000 });
    await openPersistedTrial(editor, suiteName, { failure: true });
  } finally {
    await closeProvider(provider.server);
  }
});

async function runAndVerifyEvaluation(options: {
  executor: ExecutorMode;
  page: Page;
  projectId: string;
  projectPath: string;
  providerBaseUrl: string;
  suiteName: string;
}) {
  await seedHostedEditorProject(options.page, {
    graph: accountingGraph(options.providerBaseUrl),
    extraGraphs: [{ ...accountingToolGraph, id: 'accounting-tool' }],
    graphId: 'evaluation-metrics-graph',
    loaded: true,
    projectId: options.projectId,
    projectPath: options.projectPath,
    title: options.suiteName,
  });
  await options.page.addInitScript((executor) => {
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: executor, recordExecutions: false }));
  }, options.executor);
  await options.page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(options.page);

  const editor = await getEditorRoot(options.page);
  await expect(editor.locator('.node[data-nodeid="llm"]')).toBeVisible({ timeout: 90_000 });
  await expectExecutor(editor, options.executor);
  await createBenchmarkAndRun(editor, options.suiteName);
  await openPersistedTrial(editor, options.suiteName, { failure: options.executor === 'nodejs' });
}

async function expectExecutor(editor: EditorRoot, executor: ExecutorMode) {
  await editor.locator('.more-menu').click();
  await expect(
    editor
      .getByRole('group', { name: 'Executor mode' })
      .getByRole('button', { name: executor === 'browser' ? 'Browser' : 'Node', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true', { timeout: 90_000 });
  await editor.locator('.more-menu').click();
}

async function createBenchmarkAndRun(editor: EditorRoot, suiteName: string) {
  const evaluations = editor
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Evaluations' });
  await evaluations.click();
  await editor
    .getByRole('complementary', { name: 'Evaluations resources' })
    .getByRole('button', {
      name: 'Create evaluation suite',
    })
    .click();

  const dialog = editor.getByRole('dialog');
  await dialog.getByRole('textbox').fill(suiteName);
  await dialog.getByRole('button', { name: 'Create suite' }).click();

  await getDatasetButton(editor, suiteName).click();
  await editor.getByRole('button', { name: '+ Add case' }).click();
  await getSuiteButton(editor, suiteName).click();
  const runBenchmark = editor.getByRole('button', { name: 'Run execution benchmark' });
  await expect(runBenchmark).toBeEnabled();
  await runBenchmark.click();
}

async function openPersistedTrial(editor: EditorRoot, suiteName: string, options: { failure: boolean }) {
  await editor
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Evaluations' })
    .click();
  await getSuiteButton(editor, suiteName).click();
  await editor.getByRole('tab', { name: 'Runs' }).click();
  const trial = editor.locator('.evaluation-trial');
  await expect(trial).toHaveCount(1, { timeout: 90_000 });
  await trial.locator('button.collapsible-panel-toggle').click();
  await expect(trial.getByRole('heading', { name: 'Metrics', exact: true })).toBeVisible();
  await expect(trial.locator('pre').filter({ hasText: '"modelCallCount": 2' })).toBeVisible();
  await expect(trial.getByText('Provider attempts')).toBeVisible();
  await expect(trial.locator('pre').filter({ hasText: '"provider": "custom"' })).toBeVisible();
  await expect(trial.locator('pre').filter({ hasText: '"finishReason":' })).toBeVisible();
  await expect(trial.locator('pre').filter({ hasText: '"profileName":' })).toBeVisible();

  const metrics = JSON.parse(await trial.locator('pre').filter({ hasText: '"modelCallCount": 2' }).innerText());
  expect(metrics).toMatchObject({
    inputTokens: options.failure ? 3 : 6,
    outputTokens: options.failure ? 2 : 4,
    toolCallCount: 1,
    hasUnknownCost: true,
  });
  expect(metrics).not.toHaveProperty('costUsd');
  expect(metrics.toolFailureCount ?? 0).toBe(0);
  await expect(editor.locator('.evaluation-run-summary-item').filter({ hasText: 'Total cost' })).toContainText(
    'Unavailable',
  );
  await expect(trial.locator('pre').filter({ hasText: '"kind": "profile-decision"' })).toBeVisible();
  await expect(trial.locator('pre').filter({ hasText: '"profileName": "Accounting profile"' })).toBeVisible();

  if (options.failure) {
    await expect(trial.locator('pre').filter({ hasText: '"outcome": "provider-failure"' })).toBeVisible();
  }

  // A reload must reopen this fixture's stored run, rather than a same-shaped
  // suite from a different project or a stale in-memory selection.
  await expect(getSuiteButton(editor, suiteName)).toBeVisible();
}

function getSuiteButton(editor: EditorRoot, suiteName: string) {
  const escapedName = suiteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return editor.getByRole('button', { name: new RegExp(`^${escapedName}(?: Main Graph)?$`) }).last();
}

function getDatasetButton(editor: EditorRoot, suiteName: string) {
  const escapedName = suiteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return editor.getByRole('button', { name: new RegExp(`^${escapedName} dataset \\d+ evaluation suites?$`) }).last();
}

function uniqueFixtureName(prefix: string, testInfo: { repeatEachIndex: number; retry: number; workerIndex: number }) {
  return `${prefix} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${testInfo.retry}-${Date.now().toString(36)}`;
}

async function startProvider(options: { host: string; outcome: 'failure' | 'success' }) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {
      response.end();
      return;
    }
    requests.push(request.url ?? '');

    const reply = accountingProviderResponse(requests.length - 1, options.outcome === 'failure');
    response.writeHead(reply.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing controlled provider address');
  return { port: address.port, requests, server };
}

async function closeProvider(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function getEditorRoot(page: Page): Promise<EditorRoot> {
  const frame = page.locator('iframe.dashboard-editor-frame');
  await expect
    .poll(async () => (await frame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
      message: 'Hosted editor mounts in an iframe or directly on the page',
      timeout: 60_000,
    })
    .toBe(true);
  return (await frame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
}
