import { expect, test } from '@playwright/test';
import {
  ClassifierEvaluateNodeImpl,
  LLMChatV2NodeImpl,
  deserializeProject,
  serializeProject,
  type Project,
} from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

for (const type of ['llmChatV2', 'classifierEvaluate'] as const) {
  test(`${type}: Error behavior switches update ports, body, saved data and reload`, async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    const node = type === 'llmChatV2' ? LLMChatV2NodeImpl.create() : ClassifierEvaluateNodeImpl.create();
    const item = {
      id: `error-behavior-${type}`,
      name: `Error behavior ${type}`,
      fileName: `${type}.rivet-project`,
      relativePath: `${type}.rivet-project`,
      absolutePath: `/workflows/${type}.rivet-project`,
      updatedAt: '2026-10-03T00:00:00.000Z',
      settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
    };
    let contents = serializeProject({
      metadata: { id: item.id, title: item.name, description: '', mainGraphId: 'main' },
      plugins: [],
      graphs: {
        main: {
          metadata: { id: 'main', name: 'Main Graph', description: '' },
          connections: [],
          nodes: [{ ...node, id: 'model', visualData: { x: 80, y: 100, width: 320 } }],
        },
      },
    } as unknown as Project);
    const saved: Project[] = [];
    await mockHostedEditorBootstrap(page);
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: { root: '/workflows', sync: { epoch: type, revision: 0 }, folders: [], projects: [item] },
      }),
    );
    await page.route('**/api/projects/load', (route) =>
      route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } }),
    );
    await page.route('**/api/projects/save', (route) => {
      contents = route.request().postDataJSON().contents;
      saved.push(deserializeProject(contents)[0]);
      return route.fulfill({ json: { path: item.absolutePath, revisionId: `save-${saved.length}` } });
    });
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.locator('.project-row', { hasText: item.name }).dblclick();
    const editor = page.frameLocator('iframe.dashboard-editor-frame');
    const card = editor.locator('.node[data-nodeid="model"]');
    await expect(card).toBeVisible({ timeout: 120_000 });
    await card.locator('.edit-button').dispatchEvent('click');
    const outputsHeading = editor.getByText('Outputs', { exact: true });
    if (
      (await outputsHeading.locator('xpath=ancestor::*[@aria-expanded][1]').getAttribute('aria-expanded')) === 'false'
    )
      await outputsHeading.click();
    const outputControls = outputsHeading.locator('xpath=ancestor::div[@class="Collapsible"][1]');
    const outputLabels =
      type === 'llmChatV2'
        ? ['Reasoning', 'Usage details', 'LLM attempts', 'Request body', 'Response body']
        : ['Usage details', 'Request body', 'Response body', 'Decision AI attempts'];
    for (const label of outputLabels) {
      await expect(outputControls.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(outputControls.getByText(/^Output /)).toHaveCount(0);
    if (type === 'classifierEvaluate') {
      const modelSection = editor.getByRole('button', { name: 'Model', exact: true }).and(editor.locator('button'));
      const modelContent = modelSection
        .locator('xpath=ancestor::div[@class="Collapsible"][1]')
        .locator(':scope > .Collapsible__contentOuter');
      const modelField = editor.getByRole('textbox', { name: 'Custom model', exact: true });
      const keyName = editor.getByRole('textbox', { name: 'Programmatic API key name', exact: true });
      const modelInput = editor.getByRole('button', { name: 'Use an input port for Model', exact: true });
      await expect(modelSection).toHaveAttribute('aria-expanded', 'true');
      await modelSection.click();
      await expect(modelContent).toHaveCSS('height', '0px');
      await expect(modelContent).toHaveCSS('overflow', 'hidden');
      await modelSection.click();
      await expect(modelSection).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => modelContent.evaluate((element) => (element as HTMLElement).style.height)).toBe('auto');
      await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/\bhas-unsaved-changes\b/);
      expect(saved).toHaveLength(0);
      const modelSelector = editor.getByRole('combobox', { name: 'Model', exact: true });
      await modelSelector.fill('Custom model…');
      await editor.getByText('Custom model…', { exact: true }).last().click();
      await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/\bhas-unsaved-changes\b/);
      await modelField.fill('jev-grouped-model');
      await keyName.fill('groupedApiKey');
      await expect(card).toContainText('Model: jev-grouped-model');
      await modelInput.click();
      await expect(card.getByText('Model', { exact: true })).toBeVisible();
      await modelSection.click();
      await expect(modelSection).toHaveAttribute('aria-expanded', 'false');
      await expect(modelContent).toHaveCSS('height', '0px');
      await expect(modelContent).toHaveCSS('overflow', 'hidden');
      await modelSection.click();
      await expect(modelSection).toHaveAttribute('aria-expanded', 'true');
      await modelInput.click();
      await expect(modelField).toHaveValue('jev-grouped-model');
      await expect(keyName).toHaveValue('groupedApiKey');
      await expect(card.getByText('Model', { exact: true })).toHaveCount(0);
      await editor.getByRole('button', { name: 'Input port', exact: true }).click();
      await expect(keyName).toHaveCount(0);
      await expect(card.getByText('API Key', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Automatic', exact: true }).click();
      await expect(keyName).toHaveValue('groupedApiKey');
      await expect(card.getByText('API Key', { exact: true })).toHaveCount(0);
    }
    await outputControls.getByText('Request body', { exact: true }).click();
    await expect(editor.locator('input#outputRequestBody')).toBeChecked();
    await expect(
      card.locator('.port-label', { hasText: type === 'llmChatV2' ? /^LLM request body$/ : /^Request body$/ }),
    ).toHaveCount(1);
    await outputControls.getByText('Response body', { exact: true }).click();
    await expect(editor.locator('input#outputResponseBody')).toBeChecked();
    await expect(
      card.locator('.port-label', { hasText: type === 'llmChatV2' ? /^LLM response body$/ : /^Response body$/ }),
    ).toHaveCount(1);
    const throwToggle = editor.getByRole('checkbox', { name: /^Throw exception on non-2XX status code/ });
    const catchToggle = editor.getByRole('checkbox', { name: /^Catch all exceptions/ });
    const errorHeading = editor.getByText('Error behavior', { exact: true });
    await expect(errorHeading).toBeVisible();
    if (
      (await errorHeading.locator('xpath=ancestor::*[@aria-expanded][1]').getAttribute('aria-expanded')) === 'false'
    ) {
      await errorHeading.click();
    }
    await expect(throwToggle).toBeChecked();
    await expect(catchToggle).not.toBeChecked();
    await expect(card).toContainText('Throw on non-2XX: Enabled');
    await expect(card.getByText('Run failed', { exact: true })).toHaveCount(0);

    await editor.getByText('Catch all exceptions', { exact: true }).click();
    await expect(card).toContainText('Catch all exceptions: Enabled');
    await expect(card.getByText('Run failed', { exact: true })).toBeVisible();
    await expect(card.getByText('Run error', { exact: true })).toBeVisible();
    await editor.getByText('Throw exception on non-2XX status code', { exact: true }).click();
    await expect(card).not.toContainText('Throw on non-2XX:');
    await editor.getByText('Catch all exceptions', { exact: true }).click();
    await expect(card).not.toContainText('Catch all exceptions:');
    // Decision AI failure ports are opt-in via Catch; LLM also exposes them when
    // HTTP failures are suppressed. Preserve their existing runtime contracts.
    if (type === 'classifierEvaluate') await expect(card.getByText('Run failed', { exact: true })).toHaveCount(0);
    else await expect(card.getByText('Run failed', { exact: true })).toBeVisible();
    await editor.getByText('Throw exception on non-2XX status code', { exact: true }).click();
    await expect(card.getByText('Run failed', { exact: true })).toHaveCount(0);
    await editor.getByText('Catch all exceptions', { exact: true }).click();
    await page.locator('.active-project-save-button').click();
    await expect.poll(() => saved.length).toBe(1);
    await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/\bhas-unsaved-changes\b/);
    expect(Object.values(saved[0]!.graphs)[0]!.nodes[0]!.data).toMatchObject({
      errorOnNon200: true,
      catchRequestFailed: true,
    });
    if (type === 'classifierEvaluate') {
      expect(Object.values(saved[0]!.graphs)[0]!.nodes[0]!.data).toMatchObject({
        provider: 'jev',
        model: 'jev-grouped-model',
        useModelInput: false,
        apiKeySource: 'configured',
        apiKeyNamesByProvider: {
          jev: { programmaticName: 'groupedApiKey', environmentVariableName: 'TYPESAFE_API_KEY' },
        },
      });
      const modelSection = editor.getByRole('button', { name: 'Model', exact: true }).and(editor.locator('button'));
      await modelSection.click();
      await expect(modelSection).toHaveAttribute('aria-expanded', 'false');
      await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/\bhas-unsaved-changes\b/);
      // UI preferences are debounced separately from project saves. Observe the
      // actual committed preference before testing its reload behavior.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              new Promise<boolean | undefined>((resolve, reject) => {
                const request = indexedDB.open('jotai-store');
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                  const database = request.result;
                  const transaction = database.transaction('state', 'readonly');
                  const read = transaction.objectStore('state').get('ui');
                  transaction.oncomplete = () => {
                    database.close();
                    resolve(
                      JSON.parse(read.result ?? '{}').nodeEditorGroupOpenState?.classifierEvaluate?.['group:Model:1'],
                    );
                  };
                  transaction.onabort = () => {
                    database.close();
                    reject(transaction.error);
                  };
                };
              }),
          ),
        )
        .toBe(false);
    }
    await page.reload();
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await expect(card).toContainText('Catch all exceptions: Enabled', { timeout: 120_000 });
    await card.locator('.edit-button').dispatchEvent('click');
    if (type === 'classifierEvaluate') {
      const modelSection = editor.getByRole('button', { name: 'Model', exact: true }).and(editor.locator('button'));
      await expect(modelSection).toHaveAttribute('aria-expanded', 'false');
      await modelSection.click();
      await expect(editor.getByRole('textbox', { name: 'Custom model', exact: true })).toHaveValue('jev-grouped-model');
      await expect(editor.getByRole('textbox', { name: 'Programmatic API key name', exact: true })).toHaveValue(
        'groupedApiKey',
      );
      await expect(editor.getByRole('button', { name: 'Automatic', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(card.getByText('Model', { exact: true })).toHaveCount(0);
      await expect(card.getByText('API Key', { exact: true })).toHaveCount(0);
      await expect(editor.locator('.projects-container .project.active')).not.toHaveClass(/\bhas-unsaved-changes\b/);
      expect(saved).toHaveLength(1);
    }
    await expect(throwToggle).toBeChecked();
    await expect(catchToggle).toBeChecked();
  });
}
