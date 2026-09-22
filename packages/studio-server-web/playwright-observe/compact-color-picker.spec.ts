import { expect, test } from '@playwright/test';
import { CommentNodeImpl } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('UI color controls stay compact and reveal the full picker only on click', async ({ page }) => {
  await seedHostedEditorProject(page, {
    graphId: 'compact-color-picker-graph',
    loaded: true,
    projectId: 'compact-color-picker-project',
    projectPath: '/workflows/Compact Color Picker.rivet-project',
    title: 'Compact Color Picker',
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await editor.getByRole('button', { name: 'Menu', exact: true }).click();
  await editor.getByRole('menuitem', { name: 'Rivet settings', exact: true }).click();

  const modal = editor.getByTestId('settings-modal');
  await modal.getByRole('button', { name: 'UI', exact: true }).click();
  await modal.getByRole('group', { name: 'Canvas color' }).getByRole('button', { name: 'Custom' }).click();

  const trigger = modal.getByRole('button', { name: 'Choose custom canvas color' });
  const picker = editor.getByRole('group', { name: 'Choose custom canvas color' });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(await trigger.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(48);
  await expect(picker).toHaveCount(0);

  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.saturation-white')).toBeVisible();
  const before = await trigger.locator('span').getAttribute('style');
  await picker.locator('.saturation-white').click({ position: { x: 140, y: 80 } });
  await expect.poll(() => trigger.locator('span').getAttribute('style')).not.toBe(before);
  await editor.locator('body').press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toHaveCount(0);
});

test('Comment node color fields use the same compact control', async ({ page }) => {
  const comment = CommentNodeImpl.create();
  comment.visualData = { ...comment.visualData, x: 120, y: 120, width: 320 };
  await seedHostedEditorProject(page, {
    graph: { nodes: [comment] },
    graphId: 'compact-comment-colors-graph',
    loaded: true,
    projectId: 'compact-comment-colors-project',
    projectPath: '/workflows/Compact Comment Colors.rivet-project',
    title: 'Compact Comment Colors',
  });
  await mockHostedEditorBootstrap(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const card = editor.locator(`.node[data-nodeid="${comment.id}"]`);
  await expect(card).toBeVisible();
  await card.hover();
  await card.locator('.edit-button').click();

  const textColor = editor.getByRole('button', { name: 'Choose text color' });
  const backgroundColor = editor.getByRole('button', { name: 'Choose background color' });
  await expect(textColor).toBeVisible();
  await expect(backgroundColor).toBeVisible();
  await expect(editor.getByRole('group', { name: 'Choose text color' })).toHaveCount(0);
  await textColor.click();
  const picker = editor.getByRole('group', { name: 'Choose text color' });
  await expect(picker).toBeVisible();
  await expect(editor.getByRole('group', { name: 'Choose background color' })).toHaveCount(0);
  const before = await textColor.locator('span').getAttribute('style');
  await picker.locator('.saturation-white').click({ position: { x: 140, y: 80 } });
  await expect.poll(() => textColor.locator('span').getAttribute('style')).not.toBe(before);
});
