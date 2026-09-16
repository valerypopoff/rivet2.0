import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

type EditorRoot = Page | FrameLocator;

test('HTTP Call keeps headers for every non-200 retry visible beside its terminal error', async ({ page }) => {
  const nodeId = 'rate-limited-http-call';
  const retryAfterValues = ['1', '15', '30'];
  const requestIds = retryAfterValues.map((_, index) => `rate-limit-request-429-${index + 1}`);

  await seedHostedEditorProject(page, {
    graphId: 'http-call-failure-headers-graph',
    graph: {
      nodes: [
        {
          data: {
            body: '',
            catchRequestFailed: false,
            errorOnNon200: true,
            headers: '',
            method: 'GET',
            retryOnNon200: true,
            retryOnNon200CooldownMs: 0,
            retryOnNon200RepeatTimes: 2,
            url: 'https://http-call-headers.fixture.test/rate-limited',
          },
          id: nodeId,
          title: 'HTTP Call',
          type: 'httpCall',
          visualData: { width: 300, x: 120, y: 160 },
        },
      ],
    },
    loaded: true,
    projectId: 'http-call-failure-headers-project',
    projectPath: '/workflows/HTTP Call failure headers.rivet-project',
    title: 'HTTP Call failure headers',
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      'recoil-persist',
      JSON.stringify({
        defaultExecutor: 'browser',
        recordExecutions: false,
      }),
    ),
  );
  let requestCount = 0;
  await page.route('https://http-call-headers.fixture.test/**', (route) => {
    const requestIndex = requestCount++;
    return route.fulfill({
      body: 'Too many requests',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'retry-after, x-request-id',
        'content-type': 'text/plain',
        'retry-after': retryAfterValues[requestIndex]!,
        'x-request-id': requestIds[requestIndex]!,
      },
      status: 429,
    });
  });
  await page.route('**/api/**', (route) =>
    ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.fallback() : route.abort(),
  );

  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  const editor = await getEditorRoot(page);
  const node = editor.locator(`.node[data-nodeid="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 60_000 });
  await node.hover();
  await node.locator('.edit-button').click();
  await expect(
    editor.getByText('With Retry on non-200 enabled, only the final response after all retries is checked.', {
      exact: true,
    }),
  ).toBeVisible();
  await editor.locator('.node-canvas').click({ position: { x: 700, y: 500 } });

  await editor.locator('.run-button button').first().click();
  await expect(node).toHaveClass(/error/, { timeout: 30_000 });

  const nodeOutput = node.locator('.node-output');
  await expect(nodeOutput).toContainText('HTTP call returned non-2XX status code: 429');
  await expect.poll(() => requestCount, { timeout: 30_000 }).toBe(3);

  await nodeOutput.hover();
  // Compact node output keeps its normal one-port preview. Hover expands the
  // existing preview surface, where all response metadata must be readable.
  await expect(nodeOutput).toContainText('retry-after');
  for (const requestId of requestIds) {
    await expect(nodeOutput).toContainText(requestId);
  }
  await nodeOutput.locator('.expand-button').click();
  const fullscreenOutput = editor.getByTestId('fullscreen-output-modal');
  await expect(fullscreenOutput).toContainText('HTTP call returned non-2XX status code: 429');
  await expect(fullscreenOutput).toContainText('retry-after');
  for (const requestId of requestIds) {
    await expect(fullscreenOutput).toContainText(requestId);
  }
});

async function getEditorRoot(page: Page): Promise<EditorRoot> {
  const editorFrame = page.locator('iframe.dashboard-editor-frame');
  await expect
    .poll(async () => (await editorFrame.count()) > 0 || (await page.locator('.node-canvas').first().isVisible()), {
      message: 'Hosted editor mounts in iframe or direct mode',
      timeout: 60_000,
    })
    .toBe(true);
  return (await editorFrame.count()) > 0 ? page.frameLocator('iframe.dashboard-editor-frame') : page;
}
