import { expect, test } from '@playwright/test';
import { ExecutionRecorder } from '@valerypopoff/rivet2-core';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Browser Run from here restores an opaque output port without rerunning its source', async ({ page }) => {
  await seedHostedEditorProject(page, {
    projectId: 'partial-preload-project',
    graphId: 'main',
    loaded: true,
    projectPath: '/workflows/Partial.rivet-project',
    title: 'Partial preload',
    graph: {
      nodes: [
        {
          id: 'source',
          type: 'code',
          title: 'Source',
          data: {
            code: "return { ['__proto__']: { type: 'string', value: 'preloaded value' } };",
            inputNames: [],
            outputNames: ['__proto__'],
          },
          visualData: { x: 0, y: 0, width: 240 },
        },
        {
          id: 'result',
          type: 'graphOutput',
          title: 'Result',
          data: { id: 'result', dataType: 'string' },
          visualData: { x: 400, y: 0, width: 240 },
        },
      ],
      connections: [{ outputNodeId: 'source', outputId: '__proto__', inputNodeId: 'result', inputId: 'value' }],
    },
  });
  await page.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: true })),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 503, json: { error: 'No ambient API in partial-run fixture' } }),
  );
  await mockHostedEditorBootstrap(page);
  const recordings: string[] = [];
  const unavailable: unknown[] = [];
  await page.route('**/api/workflows/local-editor-recordings**', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { supported: true } });
    if (new URL(route.request().url()).pathname.endsWith('/outcome')) {
      unavailable.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    }
    recordings.push(route.request().postDataJSON().recordingSerialized);
    return route.fulfill({
      status: 201,
      json: { availability: 'available', recordingId: `partial-${recordings.length}` },
    });
  });
  await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
  const output = page.locator('.node[data-nodeid="result"]');
  await expect(output).toBeVisible();
  await page.locator('.run-button button').first().click();
  await expect.poll(() => recordings.length).toBe(1);
  await expect(output).toHaveClass(/success/);
  await expect(page.locator('.run-button button').first()).toBeEnabled();
  await output.locator('.node-title').click({ button: 'right' });
  await expect(page.getByText('Run from here', { exact: true })).toBeVisible();
  await page.getByText('Run from here', { exact: true }).click();
  await expect.poll(() => recordings.length).toBe(2);
  await expect(output).toHaveClass(/success/);
  const first = ExecutionRecorder.deserializeFromString(recordings[0]!).events;
  const partial = ExecutionRecorder.deserializeFromString(recordings[1]!).events;
  expect(first.some((event) => event.type === 'nodeStart' && event.data.nodeId === 'source')).toBe(true);
  // Preloads intentionally replay start/finish evidence, marked as such. They
  // must not be mistaken for a second physical execution of the source.
  const sourceStarts = partial.filter((event) => event.type === 'nodeStart' && event.data.nodeId === 'source');
  expect(sourceStarts).toHaveLength(1);
  expect(sourceStarts.every((event) => event.type === 'nodeStart' && event.data.resultOrigin === 'preloaded')).toBe(
    true,
  );
  const done = partial.find((event) => event.type === 'done');
  if (done?.type !== 'done') throw new Error('Partial run did not finish');
  expect(done.data.results.result).toEqual({ type: 'string', value: 'preloaded value' });
  expect(unavailable).toEqual([]);
  await expect(page.locator('.Toastify__toast--error')).toHaveCount(0);
});
