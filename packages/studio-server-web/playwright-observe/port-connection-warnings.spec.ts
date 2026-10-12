import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

test('only established destination inputs warn, while drag preview keeps its existing colors', async ({ page }) => {
  await mockHostedEditorBootstrap(page);
  const longPortName = 'LongPortName'.repeat(40);
  const nodes = [
    {
      id: 'source',
      type: 'graphInput',
      title: 'Source',
      data: { id: 'source', dataType: 'string', defaultValue: 'evidence' },
      visualData: { x: 80, y: 260, width: 200 },
    },
    ...['connected', 'preview'].flatMap((group, column) =>
      ['string', 'number', 'llm-config'].map((dataType, row) => ({
        id: `${group}-${row}`,
        type: 'graphOutput',
        title: `${group} ${dataType}`,
        isConditional: group === 'connected' && row === 0,
        data: { id: `${group}-${row}`, dataType },
        visualData: { x: 390 + column * 310, y: 120 + row * 180, width: 220 },
      })),
    ),
    {
      id: 'loop',
      type: 'loopController',
      title: 'Loop',
      data: { maxIterations: 10, atMaxIterationsAction: 'error' },
      visualData: { x: 1020, y: 260, width: 220 },
    },
    {
      id: 'generic-object',
      type: 'object',
      title: 'Object',
      data: { jsonTemplate: '{"key": "{{input}}"}' },
      visualData: { x: 80, y: 500, width: 220 },
    },
    {
      id: 'long-name',
      type: 'graphInput',
      title: 'Long name',
      data: { id: longPortName, dataType: 'string' },
      visualData: { x: 390, y: 680, width: 220 },
    },
  ];
  await seedHostedEditorProject(page, {
    graphId: 'connection-warnings',
    projectId: 'connection-warning-project',
    projectPath: '/workflows/Connection warnings.rivet-project',
    title: 'Connection warnings',
    loaded: true,
    graph: {
      nodes,
      connections: [
        ...[0, 1, 2].map((row) => ({
          outputNodeId: 'source',
          outputId: 'data',
          inputNodeId: `connected-${row}`,
          inputId: 'value',
          ...(row === 0 ? { bendPoint: { x: 325, y: 205 } } : {}),
        })),
        ...[
          { inputNodeId: 'connected-0', inputId: '$if' },
          { inputNodeId: 'loop', inputId: 'continue' },
          { inputNodeId: 'loop', inputId: 'input1Default' },
        ].map((target) => ({ ...target, outputNodeId: 'source', outputId: 'data' })),
      ],
    },
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  const port = (id: string) =>
    editor.locator(`.port-circle[data-nodeid="${id}"][data-portid="${id === 'source' ? 'data' : 'value'}"]`);
  const neutral = port('preview-0');
  await expect(neutral).toBeVisible({ timeout: 60_000 });
  const neutralColor = await neutral.evaluate((el) => getComputedStyle(el).borderColor);
  const neutralFill = await neutral.evaluate((el) => getComputedStyle(el).backgroundColor);
  const connectedFill = await port('connected-0').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(connectedFill).not.toBe(neutralFill);
  const expectWarning = async (circle: ReturnType<typeof port>) => {
    await expect(circle).toHaveCSS('border-color', 'rgb(194, 157, 11)');
    await expect(circle).toHaveCSS('background-color', 'rgb(241, 196, 15)');
  };
  await expect(port('source')).toHaveCSS('border-color', neutralColor);
  await expect(port('source')).toHaveCSS('background-color', connectedFill);
  await expect(port('connected-0')).toHaveCSS('border-color', neutralColor);
  for (const id of ['connected-1', 'connected-2']) {
    await expectWarning(port(id));
  }
  await expect(editor.locator('.port.connection-warning:has(.output-port)')).toHaveCount(0);
  const conditionalInput = editor.locator('.port-circle[data-nodeid="connected-0"][data-portid="$if"]');
  const loopContinue = editor.locator('.port-circle[data-nodeid="loop"][data-portid="continue"]');
  const loopDefault = editor.locator('.port-circle[data-nodeid="loop"][data-portid="input1Default"]');
  await expectWarning(conditionalInput);
  for (const loopInput of [loopContinue, loopDefault]) {
    await expect(loopInput).toHaveCSS('border-color', neutralColor);
    await expect(loopInput).toHaveCSS('background-color', connectedFill);
  }

  const warningHint = editor.locator('.connection-warning:not(.port)');
  await port('connected-1').hover();
  await expect(editor.getByText('Expected data type:', { exact: true })).toBeVisible();
  const typeLabel = editor.locator('.type-row dt');
  const typeValue = editor.locator('.type-row dd');
  const labelBox = (await typeLabel.boundingBox())!;
  const valueBox = (await typeValue.boundingBox())!;
  expect(valueBox.x - (labelBox.x + labelBox.width)).toBeGreaterThan(0);
  expect(valueBox.x - (labelBox.x + labelBox.width)).toBeLessThan(8);
  await expect(warningHint).toHaveText('Actual input is string; this input expects number. Rivet will convert it.');
  await port('connected-2').hover();
  await expect(warningHint).toHaveText(
    'Actual input is string; this input expects llm-config. The types are incompatible; this connection may fail at runtime.',
  );
  await conditionalInput.hover();
  await expect(warningHint).toContainText('this input expects boolean');
  await port('connected-0').hover();
  await expect(warningHint).toHaveCount(0);
  await port('source').hover();
  await expect(warningHint).toHaveCount(0);
  await expect(editor.getByText('Data type:', { exact: true })).toBeVisible();
  await expect(editor.getByText('Expected data type:', { exact: true })).toHaveCount(0);
  await expect(editor.locator('.port-title')).toContainText('source');
  await editor.locator('.port-circle[data-nodeid="generic-object"][data-portid="input"]').hover();
  await expect(editor.getByText('Expected data type:', { exact: true })).toBeVisible();
  await expect(editor.locator('.port-title')).toHaveCount(0);
  await editor.locator('.port-circle[data-nodeid="generic-object"][data-portid="output"]').hover();
  await expect(editor.getByText('Data type:', { exact: true })).toBeVisible();
  await expect(editor.locator('.port-title')).toHaveCount(0);
  await editor.locator('.port-circle[data-nodeid="long-name"][data-portid="data"]').hover();
  const longTitle = editor.locator('.port-title');
  await expect(longTitle).toHaveText(`${longPortName} (data)`);
  const popup = longTitle.locator('..');
  const popupBox = (await popup.boundingBox())!;
  expect(popupBox.width).toBeLessThanOrEqual(376);
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(await popup.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const bend = editor.locator('.wire-bend-point[data-connection-key]');
  await expect(bend).toHaveCount(1);
  await expect(bend).toHaveCSS('stroke', neutralColor);
  await expect(bend).toHaveCSS('fill', neutralFill);
  await bend.hover();
  await expect(bend).toHaveCSS('stroke', neutralColor);
  await expect(bend).toHaveCSS('fill', neutralFill);

  // Start a real wire drag, without committing another edge.
  const box = await port('source').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(600, 900);
  await expect(port('preview-0')).toHaveCSS('border-color', 'rgb(0, 183, 76)');
  await expect(port('preview-1')).toHaveCSS('border-color', 'rgb(241, 196, 15)');
  await expect(port('preview-2')).toHaveCSS('border-color', 'rgb(231, 76, 60)');
  await expect(port('source')).toHaveCSS('background-color', connectedFill);
  await expect(port('connected-0')).toHaveCSS('border-color', neutralColor);
  await expect(port('connected-0')).toHaveCSS('background-color', connectedFill);
  await expectWarning(port('connected-1'));
  await expectWarning(port('connected-2'));
  await expectWarning(conditionalInput);
  await expect(bend).toHaveCSS('stroke', neutralColor);
  await expect(editor.locator('.port.connection-warning')).toHaveCount(3);

  // Only the actual drop target takes over an established warning.
  const warningBox = (await port('connected-2').boundingBox())!;
  await page.mouse.move(warningBox.x + warningBox.width / 2, warningBox.y + warningBox.height / 2, { steps: 8 });
  await expect(port('connected-2').locator('..')).toHaveClass(/closest/);
  await expect(port('connected-2')).toHaveCSS('border-color', 'rgb(231, 76, 60)');
  await page.mouse.move(600, 900, { steps: 8 });
  await expectWarning(port('connected-2'));
  await page.mouse.up();
  await editor.locator('.node-canvas').press('Escape');
  await expect(port('source')).toHaveCSS('background-color', connectedFill);
  await expectWarning(port('connected-2'));
  await expectWarning(conditionalInput);

  // An unsupported connection is still accepted. Its warning follows real
  // connection edits and undo/redo, rather than remaining tied to the fixture.
  const sourceBox = await port('source').boundingBox();
  const targetBox = await port('preview-2').boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(port('preview-2').locator('..')).toHaveClass(/connection-warning/);
  await expectWarning(port('preview-2'));
  await expect(port('source')).toHaveCSS('background-color', connectedFill);
  await port('preview-2').click();
  await expect(port('preview-2').locator('..')).not.toHaveClass(/connected|connection-warning/);
  // The ordinary orange hover highlight is independent of connection warnings.
  await page.mouse.move(600, 900);
  await expect(port('preview-2')).toHaveCSS('border-color', neutralColor);
  await editor.locator('.node-canvas').press('ControlOrMeta+z');
  await expect(port('preview-2').locator('..')).toHaveClass(/connection-warning/);
  await editor.locator('.node-canvas').press('ControlOrMeta+Shift+z');
  await expect(port('preview-2').locator('..')).not.toHaveClass(/connected|connection-warning/);
  await expect(port('source')).toHaveCSS('background-color', connectedFill);

  // Marquee selection alone activates a persisted midpoint; clearing selection
  // restores its neutral colors even when the point is still hovered.
  const bendBox = (await bend.boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.move(bendBox.x - 25, bendBox.y - 25);
  await page.mouse.down();
  await page.mouse.move(bendBox.x + bendBox.width + 25, bendBox.y + bendBox.height + 25, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(bend).toHaveClass(/selected/);
  await expect(bend).not.toHaveCSS('stroke', neutralColor);
  await expect(bend).not.toHaveCSS('fill', neutralFill);
  await page.mouse.click(600, 900);
  await expect(bend).not.toHaveClass(/selected/);
  await bend.hover();
  await expect(bend).toHaveCSS('stroke', neutralColor);
  await expect(bend).toHaveCSS('fill', neutralFill);

  const unselectedBox = (await bend.boundingBox())!;
  await page.mouse.move(unselectedBox.x + unselectedBox.width / 2, unselectedBox.y + unselectedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    unselectedBox.x + unselectedBox.width / 2 + 30,
    unselectedBox.y + unselectedBox.height / 2 + 15,
    { steps: 8 },
  );
  await expect(bend).toHaveClass(/dragging/);
  await expect(bend).not.toHaveClass(/selected/);
  await expect(bend).toHaveCSS('stroke', neutralColor);
  await expect(bend).toHaveCSS('fill', neutralFill);
  await page.mouse.up();
  await expect(bend).not.toHaveClass(/dragging/);

  // A compatible connection changes only the fill; disconnecting restores it.
  const compatibleBox = (await port('preview-0').boundingBox())!;
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(compatibleBox.x + compatibleBox.width / 2, compatibleBox.y + compatibleBox.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await page.mouse.move(600, 900);
  await expect(port('preview-0')).toHaveCSS('background-color', connectedFill);
  await expect(port('preview-0')).toHaveCSS('border-color', neutralColor);
  await port('preview-0').click();
  await page.mouse.move(600, 900);
  await expect(port('preview-0')).toHaveCSS('background-color', neutralFill);
  await expect(port('preview-0')).toHaveCSS('border-color', neutralColor);

  // The connected fill remains distinct but neutral in the bright theme too.
  await editor.locator('.app').evaluate((app) => {
    // Color assertions concern the settled theme, not its transition frames.
    app.querySelectorAll<HTMLElement>('.port-circle').forEach((circle) => {
      circle.style.transition = 'none';
    });
    app.classList.add('theme-bright');
    app.ownerDocument.documentElement.classList.add('theme-bright');
  });
  const brightNeutralFill = await port('preview-0').evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(port('connected-0')).not.toHaveCSS('background-color', brightNeutralFill);
  const brightBorder = await port('preview-0').evaluate((el) => getComputedStyle(el).borderColor);
  await expect(port('connected-0')).toHaveCSS('border-color', brightBorder);
  await expect(port('source')).toHaveCSS(
    'background-color',
    await port('connected-0').evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  await expectWarning(port('connected-1'));
});
