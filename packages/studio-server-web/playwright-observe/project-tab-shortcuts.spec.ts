import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';

for (const platform of ['windows', 'linux', 'macos'] as const) {
  test(`project tabs follow Chrome shortcuts on ${platform} and preserve edited snapshots`, async ({ page }) => {
    const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app/src').replaceAll('\\', '/');
    const project = projectBundleFixture().child.project;
    const projects = ['Alpha', 'Beta', 'Gamma'].map((title, index) => ({
      ...structuredClone(project),
      metadata: { ...project.metadata, id: `shortcut-project-${index}`, title },
    }));
    await page.addInitScript(
      ({ platform, projects }) => {
        Object.defineProperty(navigator, 'platform', {
          configurable: true,
          value: platform === 'macos' ? 'MacIntel' : platform === 'windows' ? 'Win32' : 'Linux x86_64',
        });
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          value: platform === 'macos' ? 'Macintosh' : platform === 'windows' ? 'Windows' : 'Linux',
        });
        Object.defineProperty(navigator, 'userAgentData', {
          configurable: true,
          value: { platform: platform === 'macos' ? 'macOS' : platform === 'windows' ? 'Windows' : 'Linux' },
        });
        (window as any).shortcutProjects = projects;
        localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
      },
      { platform, projects },
    );
    await page.route('**/project-shortcut-harness', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `
      <html><head><link rel="stylesheet" href="/@fs/${app}/host.css"></head><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module">
        await import('/shims/install-process-shim.ts');
        const { default: React } = await import('/@id/react');
        const { default: ReactDOM } = await import('/@id/react-dom/client');
        const { RivetAppHost } = await import('/@fs/${app}/host.tsx');
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RivetAppHost, {
          providers: { environment: { getEnvVar: async () => undefined } },
          onWorkspaceHostReady: (host) => { window.shortcutHost = host; },
          ui: { checkForUpdates: false, preloadCodeEditor: false },
        }));
      </script></body></html>`,
      }),
    );
    const initializationError = new Promise<never>((_resolve, reject) => page.once('pageerror', reject));
    void initializationError.catch(() => {});
    await page.goto('/project-shortcut-harness', { waitUntil: 'domcontentloaded' });
    await Promise.race([
      page.waitForFunction(() => Boolean((window as any).shortcutHost), { timeout: 120_000 }),
      initializationError,
    ]);
    await page.evaluate(async () => {
      const host = (window as any).shortcutHost;
      for (const project of (window as any).shortcutProjects) await host.openProjectSnapshot({ project });
      await host.updateProjectMetadata('shortcut-project-0', { title: 'Alpha edited' });
    });
    const tabs = page.locator('.projects-container .project');
    const active = page.locator('.projects-container .project.active');
    await expect(tabs).toHaveCount(3);
    await expect(active).toContainText('Gamma');

    // Synthetic key delivery intentionally tests the editor handler even when
    // a real browser reserves the OS shortcut for its own browser tabs.
    const switchTab = async (direction: 'left' | 'right', pageKey = false, count = 1) => {
      const code =
        platform === 'macos'
          ? direction === 'left'
            ? 'ArrowLeft'
            : 'ArrowRight'
          : pageKey
            ? direction === 'left'
              ? 'PageUp'
              : 'PageDown'
            : 'Tab';
      return page.evaluate(
        ({ code, platform, direction, count }) => {
          let consumed = true;
          for (let index = 0; index < count; index++) {
            const event = new KeyboardEvent('keydown', {
              key: code,
              code,
              ctrlKey: platform !== 'macos',
              metaKey: platform === 'macos',
              altKey: platform === 'macos',
              shiftKey: platform !== 'macos' && code === 'Tab' && direction === 'left',
              bubbles: true,
              cancelable: true,
            });
            (document.activeElement ?? document.body).dispatchEvent(event);
            consumed &&= event.defaultPrevented;
          }
          return consumed;
        },
        { code, platform, direction, count },
      );
    };

    // Input locks must win even though window capture listeners can receive
    // keys retargeted outside inert content (e.g. development refresh).
    for (const lock of ['document', 'app', 'alertdialog', 'native-dialog']) {
      await page.evaluate((lock) => {
        if (lock === 'document') document.documentElement.inert = true;
        else if (lock === 'app') document.querySelector<HTMLElement>('.app')!.inert = true;
        else {
          const dialog = document.createElement(lock === 'native-dialog' ? 'dialog' : 'div');
          dialog.id = 'shortcut-blocking-dialog';
          if (lock === 'native-dialog') dialog.setAttribute('open', '');
          else {
            dialog.setAttribute('role', 'alertdialog');
            dialog.setAttribute('aria-modal', 'true');
          }
          document.body.append(dialog);
        }
      }, lock);
      expect(await switchTab('right')).toBe(false);
      await expect(active).toContainText('Gamma');
      await page.evaluate(() => {
        document.documentElement.inert = false;
        document.querySelector<HTMLElement>('.app')!.inert = false;
        document.getElementById('shortcut-blocking-dialog')?.remove();
      });
    }

    expect(await switchTab('right')).toBe(true);
    await expect(active).toContainText('Alpha edited');
    await expect(active).toHaveClass(/has-unsaved-changes/);
    expect(await switchTab('right', true)).toBe(true);
    await expect(active).toContainText('Beta');
    expect(await switchTab('left', true)).toBe(true);
    await expect(active).toContainText('Alpha edited');
    expect(await switchTab('left')).toBe(true);
    await expect(active).toContainText('Gamma');

    // Capture handling also works from an ordinary text field, not just canvas.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'shortcut-input';
      document.body.append(input);
      input.focus();
    });
    expect(await switchTab('right')).toBe(true);
    await expect(active).toContainText('Alpha edited');
    await page.locator('#shortcut-input').evaluate((input) => input.remove());

    // Do not change the project owner while an unsaved-close dialog is open.
    await active.hover();
    await active.getByRole('button', { name: /Close Alpha edited/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await switchTab('right')).toBe(false);
    await expect(active).toContainText('Alpha edited');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Follow drag-reordered tabs rather than insertion order or recent usage.
    const beta = await tabs.filter({ hasText: 'Beta' }).locator('.project-name').boundingBox();
    const gamma = await tabs.filter({ hasText: 'Gamma' }).locator('.project-name').boundingBox();
    expect(beta).not.toBeNull();
    expect(gamma).not.toBeNull();
    await page.mouse.move(beta!.x + beta!.width / 2, beta!.y + beta!.height / 2);
    await page.mouse.down();
    await page.mouse.move(beta!.x + beta!.width / 2 + 10, beta!.y + beta!.height / 2, { steps: 2 });
    await page.mouse.move(gamma!.x + gamma!.width / 2, gamma!.y + gamma!.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(tabs.nth(1)).toContainText('Gamma');
    await expect(tabs.nth(2)).toContainText('Beta');
    expect(await switchTab('right')).toBe(true);
    await expect(active).toContainText('Gamma');
    await page.evaluate(() => (window as any).shortcutHost.activateProject('shortcut-project-0'));
    expect(await switchTab('right', false, 2)).toBe(true);
    await expect(active).toContainText('Beta');

    await page.evaluate(async () => {
      (window as any).openingTab = await (window as any).shortcutHost.startOpeningProjectTab({
        title: 'Loading Delta',
      });
    });
    await expect(active).toContainText('Loading Delta');
    expect(await switchTab('right')).toBe(true);
    await expect(active).toContainText('Alpha edited');
    expect(await switchTab('left')).toBe(true);
    await expect(active).toContainText('Loading Delta');
    await page.evaluate(() =>
      (window as any).shortcutHost.cancelOpeningProjectTab((window as any).openingTab.openingTabId),
    );
    await expect(tabs).toHaveCount(3);
    await page.evaluate(async () => {
      await (window as any).shortcutHost.closeProject('shortcut-project-1');
      await (window as any).shortcutHost.closeProject('shortcut-project-2');
    });
    await expect(tabs).toHaveCount(1);
    expect(await switchTab('right')).toBe(false);
    await expect(active).toContainText('Alpha edited');
    await expect(page.locator('.Toastify__toast--error')).toHaveCount(0);
  });
}
