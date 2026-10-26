import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { startHostedSubgraphRuntime } from '../../studio-server-api/src/tests/helpers/hosted-subgraph-runtime';

for (const mode of ['delete', 'upload'] as const) {
  for (const outcome of ['committed', 'unknown'] as const) {
    test(`obsolete bundle ${mode} completion (${outcome}) refreshes without closing the new modal`, async ({
      page,
    }) => {
      const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/');
      const app = path.resolve(web, '../app/src').replaceAll('\\', '/');
      let release!: () => void;
      const responseReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writes = 0,
        lookups = 0;
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        async (route) => {
          if (route.request().url().endsWith('/namespace/receipt')) {
            lookups++;
            return route.fulfill({ json: { state: 'unknown' } });
          }
          writes++;
          await responseReady;
          if (outcome === 'unknown') return route.abort('failed');
          return route.fulfill({
            json:
              mode === 'delete'
                ? { deleted: true, deletedProjects: [] }
                : { folder: { id: 'Imported', namespaceId: 'created', name: 'Imported' } },
          });
        },
      );
      await page.route('**/bundle-action-lifetime-harness', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><link rel="stylesheet" href="/@fs/${app}/host.css"></head><body><div id="root"></div>
        <script type="module">
          import RefreshRuntime from '/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {};
          window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;
        </script>
        <script type="module">
          await import('/shims/install-process-shim.ts');
          const { default: React } = await import('/@id/react');
          const { default: ReactDOM } = await import('/@id/react-dom/client');
          const { ${mode === 'delete' ? 'WorkflowBundleDeleteModal' : 'WorkflowBundleUploadModal'}: Modal } = await import('/@fs/${web}/dashboard/${mode === 'delete' ? 'WorkflowBundleDeleteModal' : 'WorkflowBundleUploadModal'}.tsx');
          const root = ReactDOM.createRoot(document.getElementById('root'));
          window.settled = []; window.completed = [];
          window.setModalTarget = (name) => root.render(React.createElement(Modal, {
            key: name, folder: { id: name, name, relativePath: name, absolutePath: '/managed/workflows/' + name,
              namespaceId: name === 'A' ? '191c2492-98ad-4928-820e-e3b5807a1393' : '40f5827e-7f7b-41bc-b1c8-3990547776b1',
              bundleId: '${mode === 'delete' ? '58019223-bd4e-49c3-a042-321215efaa35' : ''}', folders: [], projects: [] },
            onClose: () => {}, onStructuralMutation: (message) => window.settled.push(message),
            onDeleted: (_result, options) => { window.completed.push({ name, closeModal: options.closeModal }); if (options.closeModal) root.render(React.createElement('div', null, 'Closed')); },
            onImported: () => { window.completed.push(name); root.render(React.createElement('div', null, 'Closed')); },
          }));
          window.setModalTarget('A');
        </script></body></html>`,
        }),
      );
      try {
        await page.goto('/bundle-action-lifetime-harness', { waitUntil: 'domcontentloaded' });
        const modal = page.getByRole('dialog');
        if (mode === 'delete') {
          await modal.getByRole('textbox', { name: 'Bundle name' }).fill('A');
          await modal.getByRole('button', { name: 'Delete bundle', exact: true }).click();
        } else {
          await modal
            .locator('input[type="file"]')
            .last()
            .setInputFiles({
              name: 'bundle.zip',
              mimeType: 'application/zip',
              buffer: Buffer.from(
                zipSync({ 'rivet-bundle.json': strToU8('{}'), 'projects/root.rivet-project': strToU8('fixture') }),
              ),
            });
        }
        await expect.poll(() => writes).toBe(1);
        await page.evaluate(() => (window as any).setModalTarget('B'));
        if (mode === 'delete') await expect(modal.getByTestId('bundle-delete-name')).toHaveText('B');
        else await expect(modal).toContainText('inside B');
        release();
        await expect.poll(() => page.evaluate(() => (window as any).settled.length)).toBe(1);
        await expect(modal).toBeVisible();
        expect(await page.evaluate(() => (window as any).completed)).toEqual(
          mode === 'delete' && outcome === 'committed' ? [{ name: 'A', closeModal: false }] : [],
        );
        await expect(modal.getByRole('alert')).toHaveCount(0);
        expect(writes).toBe(1);
        expect(lookups).toBe(outcome === 'unknown' ? 1 : 0);
      } finally {
        release();
      }
    });
  }
}

// Source-host profile, like desktop-project-bundle.spec.ts: the real workspace
// and HostedIOProvider are mounted without making hosted Save As a public menu.
test('hosted Save As opens a separate identity and the next save updates only that copy', async ({ page, context }) => {
  test.setTimeout(240_000);
  const runtime = await startHostedSubgraphRuntime();
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/');
  const app = path.resolve(web, '../app/src').replaceAll('\\', '/');
  const saves: Array<{ projectId: string; path: string; saveIntent: string }> = [];
  try {
    await context.addCookies([runtime.cookie]);
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return route.fallback();
      if (url.pathname === '/api/projects/save') saves.push(request.postDataJSON());
      if (request.headers().accept === 'text/event-stream') return route.fulfill({ status: 204 });
      const response = await route.fetch({
        url: runtime.baseUrl + url.pathname + url.search,
        headers: { ...request.headers(), ...runtime.operatorHeaders },
      });
      return route.fulfill({ response });
    });
    const load = async (projectPath: string) => {
      const response = await fetch(runtime.baseUrl + '/api/projects/load', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { ...runtime.operatorHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ contents: string; revisionId: string }>;
    };
    const source = runtime.fixture.target;
    const before = await load(source.absolutePath);
    await page.route('**/hosted-save-copy-harness', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><link rel="stylesheet" href="/@fs/${app}/host.css"></head><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module">
        await import('/shims/install-process-shim.ts');
        const { default: React } = await import('/@id/react');
        const { default: ReactDOM } = await import('/@id/react-dom/client');
        const { RivetAppHost } = await import('/@fs/${app}/host.tsx');
        const { HostedIOProvider } = await import('/@fs/${web}/io/HostedIOProvider.ts');
        const { HostedDatasetProvider } = await import('/@fs/${web}/io/HostedDatasetProvider.ts');
        const { LocalEvaluationRunStore } = await import('/@fs/${app}/providers/EvaluationRunStore.ts');
        const datasets = new HostedDatasetProvider();
        const io = new HostedIOProvider(datasets, new LocalEvaluationRunStore());
        // Public Save uses its existing Save As fallback. No production test
        // hook, additional menu, fabricated save response or fake IO is needed.
        io.canSaveProjectDataNoPrompt = () => false;
        window.copyIO = io;
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RivetAppHost, {
          providers: { io, datasets },
          onWorkspaceHostReady: (host) => { window.copyHost = host; },
          ui: { checkForUpdates: false, preloadCodeEditor: false },
        }));
      </script></body></html>`,
      }),
    );
    const initializationError = new Promise<never>((_resolve, reject) => page.once('pageerror', reject));
    void initializationError.catch(() => {});
    await page.goto('/hosted-save-copy-harness', { waitUntil: 'domcontentloaded' });
    await Promise.race([
      page.waitForFunction(() => Boolean((window as any).copyHost), { timeout: 120_000 }),
      initializationError,
    ]);
    expect(await page.evaluate((p) => (window as any).copyHost.openProjectPath(p), source.absolutePath)).toBe(true);
    const moveNode = async () => {
      const node = page.locator('.node').first();
      await expect(node).toBeVisible();
      const box = (await node.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 15);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 50, box.y + 55, { steps: 6 });
      await page.mouse.up();
    };
    await moveNode();
    const copyPath = '/managed/workflows/Verified copy.rivet-project';
    page.once('dialog', (dialog) => void dialog.accept(copyPath));
    expect(await page.evaluate(() => (window as any).copyHost.saveCurrentProject())).toBe(true);
    await expect(page.locator('.projects-container .project')).toHaveCount(2);
    await expect(page.locator('.projects-container .project.active')).toContainText('Verified copy');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.saveIntent).toBe('save-as');
    const copy = await load(copyPath);
    expect(copy.contents).not.toBe(before.contents);
    expect(await load(source.absolutePath)).toEqual(before);
    await moveNode();
    await page.evaluate(() => {
      (window as any).copyIO.canSaveProjectDataNoPrompt = () => true;
    });
    expect(await page.evaluate(() => (window as any).copyHost.saveCurrentProject())).toBe(true);
    expect(saves).toHaveLength(2);
    expect(saves[1]!.saveIntent).toBe('in-place');
    expect(saves[1]!.projectId).not.toBe(saves[0]!.projectId);
    expect((await load(copyPath)).revisionId).not.toBe(copy.revisionId);
    expect(await load(source.absolutePath)).toEqual(before);
  } finally {
    await runtime.close();
  }
});
