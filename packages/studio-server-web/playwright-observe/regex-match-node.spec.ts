import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

async function openEmptyProject(page: Page, suffix: string): Promise<FrameLocator> {
  await seedHostedEditorProject(page, {
    graphId: `match-case-node-${suffix}-graph`,
    loaded: true,
    projectId: `regex-match-node-${suffix}-project`,
    projectPath: `/workflows/Match case ${suffix}.rivet-project`,
    title: `Match case ${suffix}`,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.locator('.node-canvas')).toBeVisible({ timeout: 60_000 });
  return editor;
}

test('Match case groups match, trigger, and output settings and exposes custom-value inputs only when selected', async ({
  page,
}) => {
  const editor = await openEmptyProject(page, String(Date.now()));
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position: { x: 320, y: 260 } });

  const search = editor.getByPlaceholder('Type in node name...');
  await expect(search).toBeVisible();
  await search.fill('Match case');
  await editor.locator('.context-menu-items .context-menu-label-text').filter({ hasText: /^Match case$/ }).click();

  const node = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Match case$/ }),
  });
  const fields = node.locator('.llm-node-body-field');
  const labels = node.locator('.llm-node-body-label');
  await expect(node.locator('.llm-node-body-section')).toHaveCount(3);
  await expect(fields).toHaveText([
    'Match mode: Plain text',
    'Case sensitive: Yes',
    'Trigger: First matching case',
    'Output value: true',
  ]);
  await expect(labels).toHaveText(['Match mode:', 'Case sensitive:', 'Trigger:', 'Output value:']);
  for (const label of await labels.all()) {
    await expect(label).toHaveCSS('opacity', '0.6');
  }
  await expect(node.locator('.input-ports .port-label')).toHaveText(['Input']);
  await expect(node.locator('.llm-node-body-code-value')).toHaveText('true');

  await node.locator('.node-title').click();
  const caseSensitive = editor.getByLabel('Case sensitive');
  await expect(caseSensitive).toBeChecked();
  await editor
    .locator('.toggle-editor-field', { has: editor.getByText('Case sensitive', { exact: true }) })
    .locator('.scalable-toggle')
    .click();
  await expect(caseSensitive).not.toBeChecked();
  await expect(fields.nth(1)).toHaveText('Case sensitive: No');
  await editor.getByRole('group', { name: 'Match mode' }).getByRole('button', { name: 'Regular expression' }).click();
  await expect(fields.nth(0)).toHaveText('Match mode: Regular expression');
  await expect(editor.getByLabel('Case sensitive')).toHaveCount(0);
  await expect(fields).toHaveText([
    'Match mode: Regular expression',
    'Trigger: First matching case',
    'Output value: true',
  ]);
  const triggerChoices = editor.getByRole('group', { name: 'Trigger' }).getByRole('button');
  await expect(triggerChoices).toHaveText(['First matching case', 'All matching cases']);
  await triggerChoices.filter({ hasText: 'All matching cases' }).click();
  await expect(fields.nth(1)).toHaveText('Trigger: All matching cases');

  const returnValueChoices = editor.getByRole('group', { name: 'Output value' }).getByRole('button');
  await expect(returnValueChoices).toHaveText(['True', 'Input value', 'Custom']);
  await expect(editor.getByRole('group', { name: 'Custom case values' })).toHaveCount(0);
  await returnValueChoices.filter({ hasText: /^Custom$/ }).click();
  await expect(fields).toHaveText([
    'Match mode: Regular expression',
    'Trigger: All matching cases',
    'Output value: Custom',
  ]);
  await expect(editor.getByRole('group', { name: 'Custom case values' })).toBeVisible();
  await expect(editor.getByText('Custom case values', { exact: true })).toHaveCount(0);
  await expect(node.locator('.input-ports .port-label')).toHaveText(['Input', 'Output value']);

  await editor
    .getByRole('group', { name: 'Custom case values' })
    .getByRole('button', { name: 'Custom values per case' })
    .click();
  await expect(node.locator('.match-case-values-label')).toHaveText('Output values');

  await returnValueChoices.filter({ hasText: /^Input value$/ }).click();
  await expect(editor.getByRole('group', { name: 'Custom case values' })).toHaveCount(0);
  await expect(node.locator('.match-case-values-label')).toHaveCount(0);
  await expect(node.locator('.input-ports .port-label')).toHaveText(['Input']);
});

test('Regex Match (legacy) remains available as the regex-only compatibility node', async ({ page }) => {
  const editor = await openEmptyProject(page, `legacy-${Date.now()}`);
  const canvas = editor.locator('.node-canvas');
  await canvas.click({ button: 'right', position: { x: 320, y: 260 } });

  const search = editor.getByPlaceholder('Type in node name...');
  await search.fill('Regex Match (legacy)');
  await editor
    .locator('.context-menu-items .context-menu-label-text')
    .filter({ hasText: /^Regex Match \(legacy\)$/ })
    .click();

  const node = editor.locator('.node[data-nodeid]', {
    has: editor.locator('.node-title', { hasText: /^Regex Match \(legacy\)$/ }),
  });
  await expect(node.locator('.llm-node-body-field')).toHaveText('Trigger: All matching cases');

  await node.locator('.node-title').click();
  await expect(editor.getByRole('group', { name: 'Match mode' })).toHaveCount(0);
  await expect(editor.getByText('Cases (regular expressions)', { exact: true })).toBeVisible();
});
