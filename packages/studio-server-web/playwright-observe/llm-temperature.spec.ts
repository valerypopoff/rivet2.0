import { expect, test } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import {
  LLMChatV2NodeImpl,
  LLMProfileNodeImpl,
  deserializeProject,
  serializeProject,
  type Project,
} from '@valerypopoff/rivet2-core';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

for (const type of ['llmChatV2', 'llmProfile'] as const) {
  test(`${type}: optional Temperature preserves precision, owner, saved bytes and reload recovery`, async ({
    page,
  }) => {
    const projects = ['A', 'B'].map((name) => ({
      id: `temperature-${type}-${name}`,
      name: `temperature-${name}`,
      fileName: `temperature-${name}.rivet-project`,
      relativePath: `temperature-${name}.rivet-project`,
      absolutePath: `/workflows/temperature-${name}.rivet-project`,
      updatedAt: '2026-10-03T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    }));
    const makeProject = (item: (typeof projects)[number]): Project => {
      const node = type === 'llmChatV2' ? LLMChatV2NodeImpl.create() : LLMProfileNodeImpl.create();
      return {
        metadata: { id: item.id, title: item.name, description: '', mainGraphId: 'shared-graph' },
        graphs: {
          'shared-graph': {
            metadata: { id: 'shared-graph', name: 'Main Graph', description: '' },
            connections: [],
            nodes: [
              {
                ...node,
                id: 'shared-node',
                visualData: { x: 80, y: 100, width: 320 },
                data: { ...node.data, temperature: 0.5 },
                variants: [{ id: 'legacy-temperature', data: { ...node.data, temperature: 0.75 } }],
              },
            ],
          },
        },
        plugins: [],
      } as unknown as Project;
    };
    // Inject old invalid values after serialization so save-time repair cannot
    // mask a compatibility-reader regression.
    const disk = new Map(
      projects.map((item) => [
        item.absolutePath,
        serializeProject(makeProject(item)).replaceAll(
          'temperature: 0.75',
          `temperature: ${type === 'llmChatV2' ? 'null' : '.nan'}`,
        ),
      ]),
    );
    const saved: Project[] = [];
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/workflows',
          sync: { epoch: 'temperature', revision: 0 },
          folders: [],
          projects,
        },
      }),
    );
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({
        json: {
          contents: disk.get(route.request().postDataJSON().path),
          datasetsContents: null,
          revisionId: null,
        },
      }),
    );
    await page.route('**/api/projects/save', (route) => {
      const body = route.request().postDataJSON();
      const [project] = deserializeProject(body.contents);
      saved.push(project);
      disk.set(body.path, body.contents);
      return route.fulfill({ json: { path: body.path, revisionId: `temperature-save-${saved.length}` } });
    });
    await page.goto('/');
    await waitForDashboardReady(page);
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const row = (name: string) => page.locator('.project-row', { hasText: `temperature-${name}` });
    const tab = (name: string) =>
      frame.locator('.projects-container .project').filter({ hasText: `temperature-${name}` });
    const node = frame.locator('.node[data-nodeid="shared-node"]');
    const openEditor = () => node.locator('.edit-button').dispatchEvent('click');
    const input = frame.getByLabel('Temperature', { exact: true });
    const savedTemperature = (index: number) =>
      (Object.values(saved[index]!.graphs)[0]!.nodes[0]!.data as { temperature?: number }).temperature;
    await expect(row('A')).toBeEnabled({ timeout: 120_000 });
    await row('A').dblclick();
    await openEditor();
    await expect(input).toHaveValue('0.5');
    await frame.locator('.variant-select').click();
    await frame.getByText('legacy-temperature', { exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(input).not.toBeEditable();
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await frame.locator('.variant-select').click();
    await frame.getByText('(Current)', { exact: true }).click();
    await expect(input).toHaveValue('0.5');
    await input.fill('');
    await input.pressSequentially('0.35');
    await expect(node).toContainText('Temperature: 0.35');
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saved.length).toBe(1);
    expect(savedTemperature(0)).toBe(0.35);
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);

    // Browser-invalid empty values are not deliberate clears, and parent
    // acknowledgements must preserve trailing zeroes during sequential typing.
    await input.press('End');
    await input.pressSequentially('e');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(node).toContainText('Temperature: 0.35');
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await frame.getByLabel('Max output tokens', { exact: true }).focus();
    await expect(input).toHaveValue('0.35');
    await input.fill('');
    await input.pressSequentially('0.102');
    await expect(input).toHaveValue('0.102');
    await expect(node).toContainText('Temperature: 0.102');
    await input.fill('0.35');

    // Duplicate IDs must never carry another project's numeric draft.
    await row('B').dblclick();
    await openEditor();
    await expect(input).toHaveValue('0.5');
    await input.fill('0');
    await tab('A').click();
    await expect(input).toHaveValue('0.35');
    await input.fill('');
    await tab('B').click();
    await expect(input).toHaveValue('0');
    await expect(node).toContainText('Temperature: 0');
    await tab('A').click();
    await expect(input).toHaveValue('');
    await expect(node).not.toContainText('Temperature:');
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saved.length).toBe(2);
    expect(savedTemperature(1)).toBeUndefined();
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);

    // An invalid draft on an unset optional field is also discarded on blur.
    await input.focus();
    await input.pressSequentially('-');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(node).not.toContainText('Temperature:');
    await frame.getByLabel('Max output tokens', { exact: true }).focus();
    await expect(input).toHaveValue('');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.validity.badInput)).toBe(false);
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);

    // Required fields may be temporarily blank without storing NaN.
    const required = frame.getByLabel('Max output tokens', { exact: true });
    await required.fill('');
    await expect(required).toHaveAttribute('aria-invalid', 'true');
    await expect(frame.getByText('Enter a finite number.', { exact: true })).toBeVisible();
    await input.focus();
    await expect(required).toHaveValue('1024');

    await input.fill('0.2');
    // Send the shortcut through the canvas owner, not the native input undo stack.
    await frame.locator('body').press('ControlOrMeta+z');
    await expect(input).toHaveValue('');
    await frame.locator('body').press('ControlOrMeta+Shift+z');
    await expect(input).toHaveValue('0.2');
    await input.fill('');
    await input.press('Escape');
    await openEditor();
    await expect(input).toHaveValue('');
    await tab('B').click();
    await input.fill('');

    // Wait for a committed unsaved checkpoint, then reload without server saving B.
    await input.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const editorFrame = page.frames().find((entry) => entry.url().includes('editor'))!;
    await expect
      .poll(() =>
        editorFrame.evaluate(async () => {
          const key = sessionStorage.getItem('rivet-workspace-recovery-v1');
          if (!key) return false;
          const request = indexedDB.open('jotai-store');
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const read = db.transaction('state').objectStore('state').get(key);
            const raw = await new Promise<string>((resolve, reject) => {
              read.onsuccess = () => resolve(read.result);
              read.onerror = () => reject(read.error);
            });
            const checkpoint = JSON.parse(raw);
            const active = checkpoint.groups.project.projectState;
            const graph = checkpoint.groups.graph.graphState;
            return (
              active.metadata.title === 'temperature-B' &&
              graph.metadata.id === 'shared-graph' &&
              !Object.hasOwn(graph.nodes[0].data, 'temperature')
            );
          } finally {
            db.close();
          }
        }),
      )
      .toBe(true);
    await page.reload();
    await waitForDashboardReady(page);
    await expect(tab('B')).toHaveClass(/\bactive\b/);
    await openEditor();
    await expect(input).toHaveValue('');
    await expect(node).not.toContainText('Temperature:');
    await expect(tab('B')).toHaveClass(/\bhas-unsaved-changes\b/);
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saved.length).toBe(3);
    expect(savedTemperature(2)).toBeUndefined();
    await expect(tab('B')).not.toHaveClass(/\bhas-unsaved-changes\b/);

    // Unit-converted fields preserve typing, then disclose the actual rounded
    // stored value when the user leaves the field.
    if (type === 'llmProfile') {
      await frame.getByText('LLM profile suspension', { exact: true }).click();
      const suspension = frame.getByLabel('Enable automatic suspension', { exact: true });
      await suspension.focus();
      await suspension.press('Space');
      await expect(suspension).toBeChecked();
      const timeout = frame.getByLabel('Useful output wait time, seconds', { exact: true });
      await timeout.fill('1.0005');
      await expect(timeout).toHaveValue('1.0005');
      await input.focus();
      await expect(timeout).toHaveValue('1.001');
      await page.locator('.active-project-save-button').click();
      await expect.poll(() => saved.length).toBe(4);
      expect(
        (Object.values(saved[3]!.graphs)[0]!.nodes[0]!.data as { firstOutputTimeoutMs: number }).firstOutputTimeoutMs,
      ).toBe(1001);
    }
  });
}

test('Prompt Designer uses the same optional Temperature contract in actual preview requests', async ({ page }) => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let retiredResponse: ServerResponse | undefined;
  const respond = (response: ServerResponse, content: string) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {
      response.end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: request.url!, body });
    if (body.model === 'retired-preview') {
      retiredResponse = response;
      return;
    }
    respond(response, `${body.model} response`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  try {
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const node = LLMChatV2NodeImpl.create();
    const project = {
      metadata: { id: 'designer', title: 'Temperature Designer', description: '', mainGraphId: 'main' },
      graphs: {
        main: {
          metadata: { id: 'main', name: 'Main Graph', description: '' },
          nodes: [
            { id: 'prompt', type: 'text', title: 'Prompt', data: { text: 'fixture' }, visualData: { x: 0, y: 100 } },
            {
              ...node,
              id: 'llm',
              visualData: { x: 350, y: 100, width: 320 },
              data: {
                ...node.data,
                provider: 'custom',
                model: 'fixture',
                customProviderApi: 'completions',
                customProviderBaseURL: baseURL,
                customProviderApiKeyProgrammaticName: '',
                customProviderApiKeyEnvVarName: '',
              },
            },
          ],
          connections: [{ outputNodeId: 'prompt', outputId: 'output', inputNodeId: 'llm', inputId: 'prompt' }],
        },
      },
      plugins: [],
    } as unknown as Project;
    const duplicate = structuredClone(project);
    duplicate.metadata = {
      ...duplicate.metadata,
      id: 'designer-B',
      title: 'Duplicated Designer',
    } as Project['metadata'];
    const duplicateNodes = Object.values(duplicate.graphs)[0]!.nodes;
    (duplicateNodes[0]!.data as { text: string }).text = 'fixture-B';
    (duplicateNodes[1]!.data as { temperature: number }).temperature = 0.2;
    await mockHostedEditorBootstrap(page);
    await page.addInitScript(() =>
      localStorage.setItem(
        'recoil-persist',
        JSON.stringify({
          defaultExecutor: 'browser',
          recordExecutions: false,
        }),
      ),
    );
    await page.route('**/api/config/env/*', (route) =>
      route.fulfill({
        json: {
          value: route.request().url().endsWith('/CUSTOM_PROVIDER_API_KEY') ? 'synthetic-key' : null,
        },
      }),
    );
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/workflows',
          sync: { epoch: 'designer', revision: 0 },
          folders: [],
          projects: [
            {
              id: 'designer',
              name: 'Temperature Designer',
              fileName: 'designer.rivet-project',
              relativePath: 'designer.rivet-project',
              absolutePath: '/workflows/designer.rivet-project',
              updatedAt: '2026-10-03T00:00:00.000Z',
              settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
            },
            {
              id: 'designer-B',
              name: 'Duplicated Designer',
              fileName: 'designer-B.rivet-project',
              relativePath: 'designer-B.rivet-project',
              absolutePath: '/workflows/designer-B.rivet-project',
              updatedAt: '2026-10-03T00:00:00.000Z',
              settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
            },
          ],
        },
      }),
    );
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({
        json: {
          contents: serializeProject(
            route.request().postDataJSON().path.endsWith('designer-B.rivet-project') ? duplicate : project,
          ),
          datasetsContents: null,
          revisionId: null,
        },
      }),
    );
    await page.goto('/');
    await waitForDashboardReady(page);
    await page.locator('.project-row', { hasText: 'Temperature Designer' }).dblclick();
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    await frame.locator('.run-button button').first().click();
    await expect.poll(() => requests.length).toBe(1);
    await frame.locator('.node[data-nodeid="llm"] .prompt-designer-button').dispatchEvent('click');
    const panel = frame.locator('.chat-config-controls');
    const temperature = panel.getByLabel('Temperature', { exact: true });
    await expect(temperature).toHaveValue('0.5');
    const maxTokens = panel.getByLabel('Max output tokens', { exact: true });
    await maxTokens.fill('1');
    await maxTokens.fill('0');
    await temperature.focus();
    await expect(maxTokens).toHaveValue('1');
    await temperature.fill('');
    await panel.getByLabel('Model', { exact: true }).fill('renamed-fixture');
    await panel.getByLabel('Custom provider base URL', { exact: true }).fill(`${baseURL}/alternate`);
    const run = frame.getByRole('button', { name: /^(Run|Restart) preview$/ });
    await run.click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]!.body).not.toHaveProperty('temperature');
    expect(requests[1]!.body.model).toBe('renamed-fixture');
    expect(requests[1]!.body.max_tokens).toBe(1);
    expect(requests[1]!.path).toBe('/v1/alternate/chat/completions');
    await maxTokens.fill('1024');
    await temperature.fill('0');
    await run.click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2]!.body.temperature).toBe(0);
    await temperature.fill('');
    await temperature.pressSequentially('0.102');
    await run.click();
    await expect.poll(() => requests.length).toBe(4);
    expect(requests[3]!.body.temperature).toBe(0.102);
    await expect(frame.locator('.response-text')).toHaveText('renamed-fixture response');
    await expect(frame.locator('.projects-container .project')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await panel.getByLabel('Model', { exact: true }).fill('retired-preview');
    await run.click();
    await expect.poll(() => requests.length).toBe(5);
    await expect(frame.locator('.response-text')).toBeEmpty();
    await expect(run).toHaveText('Restart preview');
    await panel.getByLabel('Model', { exact: true }).fill('fresh-preview');
    await run.click();
    await expect.poll(() => requests.length).toBe(6);
    await expect(frame.locator('.response-text')).toHaveText('fresh-preview response');
    expect(retiredResponse).toBeDefined();
    respond(retiredResponse!, 'retired response must not appear');
    await expect(run).toHaveText('Run preview');
    await expect(frame.locator('.response-text')).toHaveText('fresh-preview response');
    await panel.getByLabel('Model', { exact: true }).fill('retired-preview');
    await run.click();
    await expect.poll(() => requests.length).toBe(7);
    // Closing the designer retires its request even when the provider has not
    // finished. A duplicate node in another project starts a separate session.
    await frame.locator('.close-prompt-designer').click();
    await page.locator('.project-row', { hasText: 'Duplicated Designer' }).dblclick();
    await frame.locator('.run-button button').first().click();
    await expect.poll(() => requests.length).toBe(8);
    await frame.locator('.node[data-nodeid="llm"] .prompt-designer-button').dispatchEvent('click');
    await expect(temperature).toHaveValue('0.2');
    await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('fixture');
    await expect(panel.getByLabel('Custom provider base URL', { exact: true })).toHaveValue(baseURL);
    await expect(frame.locator('.message-area')).toContainText('fixture-B');
    await expect(frame.locator('.response-text')).toBeEmpty();
    await run.click();
    await expect.poll(() => requests.length).toBe(9);
    expect(requests[8]!.body.temperature).toBe(0.2);
    expect(JSON.stringify(requests[8]!.body.messages)).toContain('fixture-B');
    await expect(frame.locator('.response-text')).toHaveText('fixture response');
    expect(retiredResponse).toBeDefined();
    respond(retiredResponse!, 'retired response must not appear');
    await expect(frame.locator('.response-text')).toHaveText('fixture response');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
