import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

type ActiveElementDescriptor = {
  tag: string | null;
  className: string | null;
};

type Point = {
  x: number;
  y: number;
};

export async function authenticateIfNeeded(page: Page) {
  const gateInput = page.locator('#gate-key');
  if ((await gateInput.count()) === 0) {
    return;
  }

  const sharedKey = process.env.RIVET_KEY ?? '';
  expect(sharedKey, 'RIVET_KEY must be available when the UI gate is enabled').not.toBe('');

  await gateInput.fill(sharedKey);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator('button[type="submit"]').click(),
  ]);
}

export async function waitForDashboardReady(page: Page) {
  await page.locator('.dashboard-app-loading').waitFor({ state: 'hidden', timeout: 180_000 });
}

export async function describeActiveElement(page: Page): Promise<ActiveElementDescriptor> {
  return page.evaluate(() => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return {
        tag: activeElement?.tagName ?? null,
        className: null,
      };
    }

    return {
      tag: activeElement.tagName,
      className: activeElement.className || '',
    };
  });
}

export async function waitForFocusTag(page: Page, expectedTag: string, label: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const descriptor = await describeActiveElement(page);
    if (descriptor.tag === expectedTag) {
      return descriptor;
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`${label}: focus did not settle on ${expectedTag}`);
}

async function waitForNodeCountChange(
  nodes: Locator,
  previousCount: number,
  label: string,
  direction: 'increase' | 'decrease',
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const currentCount = await nodes.count();
    const changed = direction === 'increase'
      ? currentCount > previousCount
      : currentCount < previousCount;

    if (changed) {
      return currentCount;
    }

    await nodes.page().waitForTimeout(250);
  }

  throw new Error(`${label}: node count did not ${direction} from ${previousCount}`);
}

export async function waitForNodeCountIncrease(nodes: Locator, previousCount: number, label: string) {
  return waitForNodeCountChange(nodes, previousCount, label, 'increase');
}

export async function waitForNodeCountDecrease(nodes: Locator, previousCount: number, label: string) {
  return waitForNodeCountChange(nodes, previousCount, label, 'decrease');
}

export async function getVisibleNodeCenters(nodes: Locator, minVisibleX: number, maxVisibleX: number, maxVisibleY: number) {
  const centers: Point[] = [];
  const count = await nodes.count();

  for (let index = 0; index < count; index += 1) {
    const box = await nodes.nth(index).boundingBox();
    if (!box) {
      continue;
    }

    const centerX = box.x + (box.width / 2);
    const centerY = box.y + (box.height / 2);
    if (centerX <= minVisibleX || centerX >= maxVisibleX - 20 || centerY >= maxVisibleY - 20) {
      continue;
    }

    centers.push({ x: centerX, y: centerY });
  }

  return centers;
}

export async function findBlankCanvasPoint(canvas: Locator, nodes: Locator, minVisibleX: number, maxVisibleX: number, maxVisibleY: number) {
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) {
    return null;
  }

  const nodeBoxes = [];
  const count = await nodes.count();
  for (let index = 0; index < count; index += 1) {
    const box = await nodes.nth(index).boundingBox();
    if (box) {
      nodeBoxes.push(box);
    }
  }

  for (let y = canvasBox.y + 30; y < Math.min(canvasBox.y + canvasBox.height - 30, maxVisibleY - 20); y += 40) {
    for (let x = Math.max(canvasBox.x + 30, minVisibleX + 20); x < Math.min(canvasBox.x + canvasBox.width - 30, maxVisibleX - 20); x += 40) {
      const overlapsNode = nodeBoxes.some((box) =>
        x >= box.x &&
        x <= box.x + box.width &&
        y >= box.y &&
        y <= box.y + box.height,
      );

      if (!overlapsNode) {
        return { x, y };
      }
    }
  }

  return null;
}

export async function saveStepScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(name),
    fullPage: true,
  });
}
