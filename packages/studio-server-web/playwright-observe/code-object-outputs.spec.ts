import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('Code object fields retain ports and connections through incomplete editing and a key rename', async ({
  page,
}) => {
  await seedHostedEditorProject(page, {
    graphId: 'code-fields-graph',
    projectId: 'code-fields-project',
    projectPath: '/workflows/Code fields.rivet-project',
    title: 'Code fields',
    loaded: true,
    graph: {
      nodes: [
        {
          id: 'code-fields',
          type: 'codeNew',
          title: 'Code',
          visualData: { x: 100, y: 100, width: 300 },
          data: { code: 'return { foo: 111, bar: 222 };' },
        },
        ...['whole', 'foo', 'bar'].map((id, index) => ({
          id,
          type: 'codeNew',
          title: id,
          visualData: { x: 550, y: index * 210, width: 250 },
          data: { code: 'return {{value}};' },
        })),
      ],
      connections: ['output', 'field:foo', 'field:bar'].map((outputId, index) => ({
        outputNodeId: 'code-fields',
        outputId,
        inputNodeId: ['whole', 'foo', 'bar'][index],
        inputId: 'value',
      })),
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const node = editor.locator('.node[data-nodeid="code-fields"]');
  await expect(node).toBeVisible({ timeout: 60_000 });
  await expect(node.locator('.output-ports .port-label')).toHaveText(['Output', 'foo', 'bar']);
  // Open settings via its handler: the current canvas grab area overlaps the
  // settings hit target at this fixture's zoom. Pointer layout is tested elsewhere.
  await editor.locator('.run-button button').first().click();
  await expect(node.locator('.node-output')).toContainText('111');
  await expect(node.locator('.node-output')).toContainText('222');
  await expect(editor.locator('.node[data-nodeid="foo"] .node-output')).toContainText('111');
  await expect(editor.locator('.node[data-nodeid="bar"] .node-output')).toContainText('222');
  await expect(editor.locator('.node[data-nodeid="whole"] .node-output')).toContainText('foo');
  await node.locator('.edit-button').dispatchEvent('click');
  const input = editor.locator('.monaco-editor textarea').first();
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.focus();
  await input.press('Home');
  for (let index = 0; index < 12; index += 1) await input.press('ArrowRight');
  await input.press('1');
  await expect(node.locator('.output-ports .port-label')).toHaveText(['Output', 'foo1', 'bar']);
  await input.press('Escape');
  await editor.locator('.run-button button').first().click();
  await expect(editor.locator('.node[data-nodeid="foo"] .node-output')).toContainText('111');
  await node.locator('.edit-button').dispatchEvent('click');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.focus();
  await input.press('ControlOrMeta+a');
  await page.keyboard.insertText('return { foo1:');
  await expect(node.locator('.node-body')).toContainText('foo1:');
  await expect(node.locator('.output-ports .port-label')).toHaveText(['Output', 'foo1', 'bar']);
  const reopened = await page.context().newPage();
  await reopened.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(reopened);
  const restoredNode = reopened
    .frameLocator('iframe.dashboard-editor-frame')
    .locator('.node[data-nodeid="code-fields"]');
  await expect(restoredNode.locator('.node-body')).toContainText('foo1:', { timeout: 60_000 });
  await expect(restoredNode.locator('.output-ports .port-label')).toHaveText(['Output', 'foo1', 'bar']);
  await reopened.close();
  await input.press('ControlOrMeta+a');
  await page.keyboard.insertText('return { bar: 333, foo1: 444 };');
  await expect(node.locator('.output-ports .port-label')).toHaveText(['Output', 'bar', 'foo1']);
  await input.press('ControlOrMeta+a');
  await page.keyboard.insertText('return 5;');
  await expect(node.locator('.output-ports .port-label')).toHaveText(['Output']);
  await input.press('Escape');
  await editor.locator('.node-canvas').click({ position: { x: 320, y: 600 }, timeout: 10_000 });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(node.locator('.output-ports .port-label')).toHaveText(['Output', 'foo', 'bar']);
});
