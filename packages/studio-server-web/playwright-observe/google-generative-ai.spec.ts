import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

const projectName = 'Hosted Google browser stream';
const projectPath = `/workflows/${projectName}.rivet-project`;

type GoogleStreamMode = 'text' | 'tool' | 'error' | 'rate-limit' | 'pending';

type FixtureOptions = {
  mode: GoogleStreamMode;
  withFunctionOutput?: boolean;
};

const fixture = ({ withFunctionOutput = false }: FixtureOptions) => `version: 4
data:
  metadata:
    id: hosted-google-browser-stream
    title: "${projectName}"
    description: ""
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[prompt]:prompt "Prompt"':
          data:
            type: user
            useTypeInput: false
            promptText: synthetic request
            enableFunctionCall: false
          visualData: 100/240/260/null//
          outgoingConnections:
            - output->"Google" google/prompt
        '[google]:chatGoogle "Google"':
          data:
            model: gemini-2.5-flash
            useModelInput: false
            temperature: 0
            useTemperatureInput: false
            top_p: 1
            useTopPInput: false
            top_k: null
            useTopKInput: false
            useTopP: false
            useUseTopPInput: false
            maxTokens: 64
            useMaxTokensInput: false
            cache: false
            useAsGraphPartialOutput: true
            useToolCalling: ${withFunctionOutput}
            thinkingBudget: null
            useThinkingBudgetInput: false
            headers:
              - key: X-Rivet-Stream-Test
                value: browser-safe
            useHeadersInput: false
          visualData: 520/220/300/null//
          outgoingConnections:${withFunctionOutput ? '\n            - function-calls->"Function output" function-output/input' : ' []'}
${
  withFunctionOutput
    ? `        '[function-output]:text "Function output"':
          data:
            text: "{{input.0.name}}"
            normalizeLineEndings: true
          visualData: 920/220/300/null//
`
    : ''
}
  plugins:
    - type: built-in
      id: google
      name: Google
  references: []
`;

const project: WorkflowProjectItem = {
  id: 'hosted-google-browser-stream',
  name: projectName,
  fileName: `${projectName}.rivet-project`,
  relativePath: `${projectName}.rivet-project`,
  absolutePath: projectPath,
  updatedAt: '2026-09-14T00:00:00.000Z',
  settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
};

async function installGoogleStreamingFixture(page: Page, mode: GoogleStreamMode): Promise<void> {
  await page.addInitScript((configuredMode: GoogleStreamMode) => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const fixtureWindow = window as Window & {
      __rivetGoogleStreamingRequests?: Array<{ aborted: boolean; customHeader: string | null; url: string }>;
    };
    const requestLogOwner = window.top as typeof fixtureWindow;
    requestLogOwner.__rivetGoogleStreamingRequests ??= [];
    let returnedRateLimit = false;

    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);

      if (url.hostname !== 'generativelanguage.googleapis.com' || !url.pathname.includes(':streamGenerateContent')) {
        return originalFetch(input, init);
      }

      const requestRecord = {
        aborted: false,
        customHeader: request.headers.get('X-Rivet-Stream-Test'),
        url: request.url,
      };
      requestLogOwner.__rivetGoogleStreamingRequests!.push(requestRecord);

      if (configuredMode === 'error') {
        return new Response(JSON.stringify({ error: { code: 400, message: 'synthetic invalid request' } }), {
          headers: { 'content-type': 'application/json' },
          status: 400,
        });
      }

      if (configuredMode === 'rate-limit' && !returnedRateLimit) {
        returnedRateLimit = true;
        return new Response(JSON.stringify({ error: { code: 429, message: 'synthetic rate limit' } }), {
          headers: { 'content-type': 'application/json' },
          status: 429,
        });
      }

      const events =
        configuredMode === 'tool'
          ? ['data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"city":"Tbilisi"}}}]}}]}\n\n']
          : [
              'data: {"candidates":[{"content":{"parts":[{"text":"first "}]}}]}\n\n',
              'data: {"candidates":[{"content":{"parts":[{"text":"final"}]},"finishReason":"STOP"}]}\n\n',
            ];

      return new Response(
        new ReadableStream({
          start(controller) {
            const firstEvent = window.setTimeout(() => controller.enqueue(encoder.encode(events[0]!)), 150);
            const finalEvent =
              configuredMode === 'pending'
                ? undefined
                : window.setTimeout(() => {
                    controller.enqueue(encoder.encode(events[1]!));
                    controller.close();
                  }, 650);

            request.signal.addEventListener(
              'abort',
              () => {
                window.clearTimeout(firstEvent);
                if (finalEvent !== undefined) {
                  window.clearTimeout(finalEvent);
                }
                requestRecord.aborted = true;
                controller.error(request.signal.reason ?? new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' }, status: 200 },
      );
    };

    localStorage.setItem(
      'recoil-persist',
      JSON.stringify({
        defaultExecutor: 'browser',
        recordExecutions: false,
        settings: { googleApiKey: 'synthetic-browser-key' },
      }),
    );
  }, mode);
}

async function openFixture(page: Page, options: FixtureOptions): Promise<FrameLocator> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/workflows/tree' && request.method() === 'GET') {
      const tree: WorkflowTreeResponse = {
        root: '/workflows',
        sync: { epoch: 'hosted-google-browser-stream', revision: 0 },
        folders: [],
        projects: [project],
      };
      await route.fulfill({ json: tree });
    } else if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents: fixture(options), datasetsContents: null, revisionId: null } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      await route.abort('blockedbyclient');
    } else {
      await route.fallback();
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: projectName }).dblclick();

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  // Project declarations are deliberately portable, while built-in plugins are
  // installed at the app level. Install this fixture's declared Google plugin
  // through the same UI a user uses, rather than bypassing the plugin registry.
  const missingPluginsModal = editor.getByRole('dialog').filter({ hasText: 'Project Plugins Not Installed' });
  const pluginNeedsInstalling = await missingPluginsModal
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (pluginNeedsInstalling) {
    await missingPluginsModal.getByRole('button', { name: 'Install' }).click();
    await expect(missingPluginsModal).toBeHidden();
  }

  await expect(editor.locator('.node[data-nodeid="google"]')).toBeVisible({ timeout: 90_000 });
  return editor;
}

test('hosted legacy Google Chat uses the browser GenAI stream without provider egress', async ({ page }) => {
  await installGoogleStreamingFixture(page, 'text');
  const editor = await openFixture(page, { mode: 'text' });
  const googleNode = editor.locator('.node[data-nodeid="google"]');

  await editor.locator('.run-button button').first().click();
  await expect(googleNode).toHaveClass(/running/);
  await expect(googleNode.locator('.node-output')).toContainText('first', { timeout: 30_000 });
  await expect(googleNode).toHaveClass(/success/, { timeout: 30_000 });
  await expect(googleNode.locator('.node-output')).toContainText('first final');

  const googleRequests = await page.evaluate(() => {
    const fixtureWindow = window as Window & {
      __rivetGoogleStreamingRequests?: Array<{ aborted: boolean; customHeader: string | null; url: string }>;
    };
    return fixtureWindow.__rivetGoogleStreamingRequests;
  });
  expect(googleRequests).toEqual([
    {
      aborted: false,
      customHeader: 'browser-safe',
      url: expect.stringContaining(':streamGenerateContent'),
    },
  ]);
});

test('hosted legacy Google Chat exposes streamed function calls through its existing output', async ({ page }) => {
  await installGoogleStreamingFixture(page, 'tool');
  const editor = await openFixture(page, { mode: 'tool', withFunctionOutput: true });
  const googleNode = editor.locator('.node[data-nodeid="google"]');
  const functionOutput = editor.locator('.node[data-nodeid="function-output"]');

  await editor.locator('.run-button button').first().click();
  await expect(googleNode).toHaveClass(/success/, { timeout: 30_000 });
  await expect(functionOutput).toHaveClass(/success/, { timeout: 30_000 });
  await expect(functionOutput.locator('.node-output')).toContainText('lookup');
});

test('hosted legacy Google Chat keeps the non-retryable provider error at the node boundary', async ({ page }) => {
  await installGoogleStreamingFixture(page, 'error');
  const editor = await openFixture(page, { mode: 'error' });
  const googleNode = editor.locator('.node[data-nodeid="google"]');

  await editor.locator('.run-button button').first().click();
  await expect(googleNode).toHaveClass(/error/, { timeout: 30_000 });
  await expect(googleNode.locator('.node-output')).toContainText('Google API error: 400', { timeout: 30_000 });
});

test('hosted legacy Google Chat retries a rate limit and preserves the successful stream', async ({ page }) => {
  await installGoogleStreamingFixture(page, 'rate-limit');
  const editor = await openFixture(page, { mode: 'rate-limit' });
  const googleNode = editor.locator('.node[data-nodeid="google"]');

  await editor.locator('.run-button button').first().click();
  await expect(googleNode).toHaveClass(/success/, { timeout: 30_000 });
  await expect(googleNode.locator('.node-output')).toContainText('first final');

  const requests = await page.evaluate(() => {
    const fixtureWindow = window as Window & { __rivetGoogleStreamingRequests?: unknown[] };
    return fixtureWindow.__rivetGoogleStreamingRequests;
  });
  expect(requests).toHaveLength(2);
});

test('stopping a pending hosted Google stream aborts the SDK request without accepting a late output', async ({ page }) => {
  await installGoogleStreamingFixture(page, 'pending');
  const editor = await openFixture(page, { mode: 'pending' });
  const googleNode = editor.locator('.node[data-nodeid="google"]');

  await editor.locator('.run-button button').first().click();
  await expect(googleNode.locator('.node-output')).toContainText('first', { timeout: 30_000 });
  await editor.getByRole('button', { name: 'Abort', exact: true }).first().click();
  await expect(editor.locator('.run-button.running')).toHaveCount(0, { timeout: 30_000 });
  await expect(googleNode.locator('.node-output')).not.toContainText('late');

  const requests = await page.evaluate(() => {
    const fixtureWindow = window as Window & {
      __rivetGoogleStreamingRequests?: Array<{ aborted: boolean }>;
    };
    return fixtureWindow.__rivetGoogleStreamingRequests;
  });
  expect(requests).toEqual([expect.objectContaining({ aborted: true })]);
});
