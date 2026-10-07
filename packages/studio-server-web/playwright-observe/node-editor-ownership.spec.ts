import { expect, test } from '@playwright/test';
import { deserializeProject, serializeProject, type NodePrefabId, type Project } from '@valerypopoff/rivet2-core';
import { mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

for (const type of ['object', 'codeNew']) {
  test(`${type}: library source editing is isolated from graphs, other sources and cloned projects`, async ({
    page,
  }) => {
    const field = type === 'object' ? 'jsonTemplate' : 'code';
    const firstId = 'first' as NodePrefabId;
    const secondId = 'second' as NodePrefabId;
    const value = (marker: string) => (type === 'object' ? JSON.stringify({ marker }) : `return "${marker}";`);
    const projects = ['A', 'B'].map((name) => ({
      id: `library-${name}`,
      name: `library-${name}`,
      fileName: `library-${name}.rivet-project`,
      relativePath: `library-${name}.rivet-project`,
      absolutePath: `/workflows/library-${name}.rivet-project`,
      updatedAt: '2026-10-02T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    }));
    const source = (id: string, marker: string, x = 0) => ({
      id,
      type,
      title: marker,
      data: { [field]: value(marker) },
      visualData: { x, y: 0, width: 260 },
    });
    const contents = (id: string) =>
      serializeProject({
        metadata: { id, title: id, mainGraphId: 'shared-graph', description: '' },
        graphs: {
          'shared-graph': {
            metadata: { id: 'shared-graph', name: 'Main', description: '' },
            nodes: [source('shared-node', 'graph-original')],
            connections: [],
          },
        },
        nodePrefabs: {
          first: { id: 'first', sourceNode: source('shared-node', 'first-original') },
          second: { id: 'second', sourceNode: source('other-source', 'second-original', 350) },
        },
        plugins: [],
        references: [],
      } as unknown as Project);
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/workflows',
          sync: { epoch: 'library-ownership', revision: 0 },
          folders: [],
          projects,
        },
      }),
    );
    await page.route('**/api/projects/load', (route) => {
      const { path } = route.request().postDataJSON();
      const project = projects.find((entry) => entry.absolutePath === path)!;
      return route.fulfill({ json: { contents: contents(project.id), datasetsContents: null, revisionId: null } });
    });
    const saves: Project[] = [];
    await page.route('**/api/projects/save', (route) => {
      const body = route.request().postDataJSON();
      saves.push(deserializeProject(body.contents)[0]);
      return route.fulfill({ json: { path: body.path, revisionId: `library-save-${saves.length}` } });
    });
    await page.goto('/');
    await waitForDashboardReady(page);
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const row = (name: string) => page.locator('.project-row', { hasText: `library-${name}` });
    const tab = (name: string) => frame.locator('.projects-container .project').filter({ hasText: `library-${name}` });
    const view = frame.locator('.monaco-editor .view-lines').first();
    const openSource = async (id: string) => {
      await frame.locator(`.node[data-nodeid="${id}"] .edit-button`).dispatchEvent('click');
    };
    const edit = async (marker: string) => {
      const input = frame.locator('.monaco-editor textarea').first();
      await input.focus();
      await input.press('ControlOrMeta+a');
      await input.press('Backspace');
      await page.keyboard.insertText(value(marker));
    };
    await expect(row('A')).toBeEnabled({ timeout: 120_000 });
    await row('A').dblclick();
    await expect(tab('A')).toHaveClass(/\bactive\b/);
    await openSource('shared-node');
    await expect(view).toContainText('graph-original');
    await frame.getByText('Node library', { exact: true }).click();
    await openSource('shared-node');
    await expect(view).toContainText('first-original');
    await edit('A-first-edited');
    await openSource('other-source');
    await expect(view).toContainText('second-original');
    await edit('A-second-edited');
    await row('B').dblclick();
    await expect(tab('B')).toHaveClass(/\bactive\b/);
    await frame.getByText('Node library', { exact: true }).click();
    await openSource('shared-node');
    await expect(view).toContainText('first-original');
    await edit('B-first-edited');
    await tab('A').click();
    await expect(view).toContainText('A-second-edited');
    await openSource('shared-node');
    await expect(view).toContainText('A-first-edited');
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saves.length).toBe(1);
    const a = saves[0]!;
    expect(a.nodePrefabs![firstId]!.sourceNode.data).toMatchObject({ [field]: value('A-first-edited') });
    expect(a.nodePrefabs![secondId]!.sourceNode.data).toMatchObject({ [field]: value('A-second-edited') });
    expect(a.graphs['shared-graph' as keyof typeof a.graphs]!.nodes[0]!.data).toMatchObject({
      [field]: value('graph-original'),
    });
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await tab('B').click();
    await expect(view).toContainText('B-first-edited');
    await expect(tab('B')).toHaveClass(/\bhas-unsaved-changes\b/);
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saves.length).toBe(2);
    expect(saves[1]!.nodePrefabs![firstId]!.sourceNode.data).toMatchObject({ [field]: value('B-first-edited') });
    expect(saves[1]!.nodePrefabs![secondId]!.sourceNode.data).toMatchObject({ [field]: value('second-original') });
  });
}

const cases = [
  {
    type: 'object',
    field: 'jsonTemplate',
    initial: '{"marker":"original-A"}',
    a: '{"marker":"edited-A"}',
    b: '{"marker":"edited-B"}',
  },
  { type: 'codeNew', field: 'code', initial: 'return "original-A";', a: 'return "edited-A";', b: 'return "edited-B";' },
  { type: 'code', field: 'code', initial: 'return "original-A";', a: 'return "edited-A";', b: 'return "edited-B";' },
  { type: 'prompt', field: 'promptText', initial: 'original-A', a: 'edited-A', b: 'edited-B' },
];

for (const fixture of cases) {
  test(`${fixture.type}: cloned IDs preserve focused and blurred edits, dirty state and saved bytes`, async ({
    page,
  }) => {
    const projects = ['A', 'B'].map((name) => ({
      id: `ownership-${name}`,
      name: `ownership-${name}`,
      fileName: `ownership-${name}.rivet-project`,
      relativePath: `ownership-${name}.rivet-project`,
      absolutePath: `/workflows/ownership-${name}.rivet-project`,
      updatedAt: '2026-10-02T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    }));
    const contents = (project: (typeof projects)[number]) =>
      serializeProject({
        metadata: { id: project.id, title: project.name, description: '', mainGraphId: 'shared-graph' },
        graphs: {
          'shared-graph': {
            metadata: { id: 'shared-graph', name: 'Main Graph', description: '' },
            nodes: [
              {
                id: 'shared-node',
                type: fixture.type,
                title: 'Ownership Node',
                visualData: { x: 520, y: 300, width: 260 },
                data: { [fixture.field]: fixture.initial, ...(fixture.type === 'prompt' ? { type: 'user' } : {}) },
                variants: [
                  {
                    id: 'alternate',
                    data: {
                      [fixture.field]: fixture.a.replace('edited-A', 'variant-preview'),
                      ...(fixture.type === 'prompt' ? { type: 'user' } : {}),
                    },
                  },
                ],
              },
            ],
            connections: [],
          },
        },
        plugins: [],
        references: [],
      } as unknown as Project);
    let releaseDictionary!: () => void;
    let dictionaryRequested = false;
    if (fixture.type === 'prompt') {
      const dictionaryReady = new Promise<void>((resolve) => {
        releaseDictionary = resolve;
      });
      await page.route(/rivet-dictionary-en-browser/, async (route) => {
        dictionaryRequested = true;
        await dictionaryReady;
        await route.continue();
      });
    }
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/workflows',
          sync: { epoch: 'ownership', revision: 0 },
          folders: [],
          projects,
        },
      }),
    );
    let loads = 0;
    await page.route('**/api/projects/load', (route) => {
      const { path } = route.request().postDataJSON();
      const project = projects.find((entry) => entry.absolutePath === path);
      expect(project).toBeDefined();
      loads++;
      return route.fulfill({ json: { contents: contents(project!), datasetsContents: null, revisionId: null } });
    });
    const saves: { path: string; value: unknown; title: string; description?: string }[] = [];
    await page.route('**/api/projects/save', (route) => {
      const body = route.request().postDataJSON();
      const [project] = deserializeProject(body.contents);
      const node = Object.values(project.graphs)[0]!.nodes.find((entry) => entry.id === 'shared-node')!;
      saves.push({
        path: body.path,
        value: (node.data as Record<string, unknown>)[fixture.field],
        title: node.title,
        description: node.description,
      });
      return route.fulfill({ json: { path: body.path, revisionId: `ownership-save-${saves.length}` } });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForDashboardReady(page);
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const tabs = frame.locator('.projects-container .project:not(.opening)');
    const tab = (name: string) => tabs.filter({ hasText: `ownership-${name}` });
    const row = (name: string) => page.locator('.project-row', { hasText: `ownership-${name}` });
    const node = frame.locator('.node[data-nodeid="shared-node"]');
    const input = frame.locator('.monaco-editor textarea').first();
    const view = frame.locator('.monaco-editor .view-lines').first();
    const edit = async (text: string) => {
      await input.focus();
      await input.press('ControlOrMeta+a');
      await input.press('Backspace');
      await page.keyboard.insertText(text);
    };
    await expect(row('A')).toBeEnabled({ timeout: 120_000 });
    await row('A').dblclick();
    await expect(tab('A')).toHaveClass(/\bactive\b/);
    await node.locator('.edit-button').dispatchEvent('click');
    await expect(view).toContainText('original-A');
    await row('B').dblclick();
    await expect(tab('B')).toHaveClass(/\bactive\b/);
    await node.locator('.edit-button').dispatchEvent('click');
    if (fixture.type === 'prompt') {
      try {
        await edit('mispelled wrds');
        const checkSpelling = async () => {
          await view.click({ button: 'right' });
          // Monaco arms pointer actions after 100 ms and a programmatic
          // focus alone does not update its ActionBar selection. Navigate
          // to the first action through the keyboard before invoking it.
          const action = frame.getByRole('menuitem', { name: 'Check spelling', exact: true });
          await action.press('ArrowDown');
          await expect(action).toBeFocused();
          await action.press('Enter');
        };
        await checkSpelling();
        await expect(frame.locator('.editor-spellcheck-status')).toHaveText('Checking spelling...');
        await expect.poll(() => dictionaryRequested).toBe(true);
        await checkSpelling();
        releaseDictionary();
        await expect(frame.locator('.editor-spellcheck-status')).toHaveText('2 possible spelling issues');
        // The superseded check must not clear the newer check's markers.
        await expect(frame.locator('.monaco-editor .squiggly-warning')).toHaveCount(2);
      } finally {
        releaseDictionary();
      }
    }
    await edit(fixture.b);
    if (fixture.type === 'prompt') {
      await expect(frame.locator('.editor-spellcheck-status')).toHaveCount(0);
      await expect(frame.locator('.monaco-editor .squiggly-warning')).toHaveCount(0);
    }
    // Exercise the focused transition before touching another settings field.
    await tab('A').click();
    await expect(view).toContainText('original-A');
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await expect(tab('B')).toHaveClass(/\bhas-unsaved-changes\b/);
    await tab('B').click();
    await expect(view).toContainText('edited-B');
    // Reuse the loaded workspace for the unfocused race, but use a different
    // value so an old snapshot cannot accidentally satisfy the assertion.
    const blurredB = fixture.b.replace('edited-B', 'blurred-B');
    await edit(blurredB);
    await input.evaluate((element) => (element as HTMLElement).blur());
    if (fixture.type === 'codeNew') {
      await frame.getByRole('button', { name: 'Edit node title', exact: true }).click();
      await frame.locator('#node-title-shared-node').fill('Edited B node');
      await frame.locator('.description-read-content').click();
      await frame.locator('.node-description-field textarea').fill('Edited B description');
    }
    // No debounce wait: leaving must preserve the last input event.
    await tab('A').click();
    await expect(tab('A')).toHaveClass(/\bactive\b/);
    await expect(view).toContainText('original-A');
    await expect(view).not.toContainText('blurred-B');
    await expect(node.locator('.node-body')).toContainText('original-A');
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await expect(tab('B')).toHaveClass(/\bhas-unsaved-changes\b/);
    if (fixture.type === 'codeNew') {
      await expect(frame.getByRole('button', { name: 'Edit node title', exact: true })).toHaveText('Ownership Node');
      await expect(frame.locator('.description-read-content')).toHaveText('Description...');
    }
    await frame.locator('.variant-select').click();
    await frame.getByText('alternate', { exact: true }).click();
    await expect(view).toContainText('variant-preview');
    await input.focus();
    await page.keyboard.insertText('must-not-change-variant');
    await expect(view).not.toContainText('must-not-change-variant');
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await frame.locator('.variant-select').click();
    await frame.getByText('(Current)', { exact: true }).click();
    await expect(view).toContainText('original-A');
    await edit(fixture.a);
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saves.find((entry) => entry.path === projects[0]!.absolutePath)?.value).toBe(fixture.a);
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    await tab('B').click();
    await expect(view).toContainText('blurred-B');
    await expect(node.locator('.node-body')).toContainText('blurred-B');
    await expect(tab('B')).toHaveClass(/\bhas-unsaved-changes\b/);
    if (fixture.type === 'codeNew') {
      await expect(frame.getByRole('button', { name: 'Edit node title', exact: true })).toHaveText('Edited B node');
      await expect(frame.locator('.description-read-content')).toHaveText('Edited B description');
    }
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saves.find((entry) => entry.path === projects[1]!.absolutePath)?.value).toBe(blurredB);
    if (fixture.type === 'codeNew') {
      expect(saves.find((entry) => entry.path === projects[1]!.absolutePath)).toMatchObject({
        title: 'Edited B node',
        description: 'Edited B description',
      });
    }
    await tab('A').click();
    await expect(view).toContainText('edited-A');
    await row('A').dblclick();
    await expect(view).toContainText('edited-A');
    expect(loads).toBe(2);
    await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    if (fixture.type === 'codeNew') {
      await frame.getByRole('button', { name: 'Edit node title', exact: true }).click();
      await frame.locator('#node-title-shared-node').fill('Cancel this title');
      await frame.locator('#node-title-shared-node').press('Escape');
      await expect(frame.getByRole('button', { name: 'Edit node title', exact: true })).toHaveText('Ownership Node');
      await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
      await frame.locator('.description-read-content').click();
      await frame.locator('.node-description-field textarea').fill('Cancel this description');
      await frame.locator('.node-description-field textarea').press('Escape');
      await expect(frame.locator('.description-read-content')).toHaveText('Description...');
      await expect(tab('A')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    }
  });
}

test('JSON object drafts stay with their owner and formatting acknowledgements preserve text', async ({ page }) => {
  const projects = ['A', 'B'].map((name) => ({
    id: `json-${name}`,
    name: `json-${name}`,
    fileName: `json-${name}.rivet-project`,
    relativePath: `json-${name}.rivet-project`,
    absolutePath: `/workflows/json-${name}.rivet-project`,
    updatedAt: '2026-10-02T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  }));
  const contents = (id: string) =>
    serializeProject({
      metadata: { id, title: id, description: '', mainGraphId: 'shared-graph' },
      graphs: {
        'shared-graph': {
          metadata: { id: 'shared-graph', name: 'Main', description: '' },
          connections: [],
          nodes: [
            {
              id: 'shared-node',
              type: 'knowledgeDocument',
              title: 'Document',
              visualData: { x: 520, y: 300, width: 260 },
              data: {
                text: '',
                documentId: '',
                title: '',
                metadata: { marker: 'original' },
                useTextInput: false,
                useDocumentIdInput: false,
                useTitleInput: false,
                useMetadataInput: false,
              },
            },
          ],
        },
      },
      plugins: [],
      references: [],
    } as unknown as Project);
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', (route) =>
    route.fulfill({
      json: {
        root: '/workflows',
        sync: { epoch: 'json-ownership', revision: 0 },
        folders: [],
        projects,
      },
    }),
  );
  await page.route('**/api/projects/load', (route) => {
    const { path } = route.request().postDataJSON();
    const project = projects.find((entry) => entry.absolutePath === path)!;
    return route.fulfill({ json: { contents: contents(project.id), datasetsContents: null, revisionId: null } });
  });
  let savedMetadata: unknown;
  await page.route('**/api/projects/save', (route) => {
    const body = route.request().postDataJSON();
    const [project] = deserializeProject(body.contents);
    savedMetadata = (Object.values(project.graphs)[0]!.nodes[0]!.data as Record<string, unknown>).metadata;
    return route.fulfill({ json: { path: body.path, revisionId: 'json-saved' } });
  });
  await page.goto('/');
  await waitForDashboardReady(page);
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const tab = (name: string) => frame.locator('.projects-container .project').filter({ hasText: `json-${name}` });
  const row = (name: string) => page.locator('.project-row', { hasText: `json-${name}` });
  const input = frame.locator('.row.jsonObject .monaco-editor textarea');
  const view = frame.locator('.row.jsonObject .monaco-editor .view-lines');
  const edit = async (text: string) => {
    await input.focus();
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    await page.keyboard.insertText(text);
  };
  await expect(row('A')).toBeEnabled({ timeout: 120_000 });
  await row('A').dblclick();
  await frame.locator('.node[data-nodeid="shared-node"] .edit-button').dispatchEvent('click');
  await expect(view).toContainText('original');
  await edit('{"marker":');
  // Monaco renders model edits asynchronously. Capture the draft only after
  // both its visible text and validation settle, never during the empty render
  // between select-all/delete and insertion (especially on hosted CI runners).
  await expect(view).toContainText('{"marker":');
  const error = frame.locator('.row.jsonObject .node-editor-code-helper-after');
  await expect(error).toBeVisible();
  const draft = await view.innerText();
  const errorText = await error.innerText();
  await row('B').dblclick();
  await frame.locator('.node[data-nodeid="shared-node"] .edit-button').dispatchEvent('click');
  await expect(view).toContainText('original');
  await edit('{"marker":"B"}');
  await expect(view).toHaveText('{"marker":"B"}');
  await expect(error).toHaveCount(0);
  await tab('A').click();
  await expect(view).toHaveText(draft);
  await expect(error).toHaveText(errorText);
  await edit('{"marker":"A"}');
  await expect(error).toHaveCount(0);
  // A canonical pretty-printed object acknowledgement must not reformat the
  // user's compact text or reset their cursor on every valid keystroke.
  await expect(view).toHaveText('{"marker":"A"}');
  await page.locator('.active-project-save-button').click();
  await expect.poll(() => savedMetadata).toEqual({ marker: 'A' });
  await tab('B').click();
  await expect(view).toHaveText('{"marker":"B"}');
});
