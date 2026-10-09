import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

test.use({ actionTimeout: 15_000 });

const projectName = 'Hosted Classifier node migration';
const projectPath = `/workflows/${projectName}.rivet-project`;

const fixture = `version: 4
data:
  metadata:
    id: hosted-jev-node-family
    title: "${projectName}"
    description: ""
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[choice]:jevChoiceQuestion "Jev Choice Question"':
          data:
            questionId: route
            instructions: "Route {{subject}}"
            options:
              - key: sales
                value: Sales questions
              - key: support
                value: Support questions
          visualData: 160/180/300/null//
          outgoingConnections: []
        '[evaluate]:jevEvaluate "Jev Evaluate"':
          data:
            model: jev-latest
            timeoutMs: 30000
          visualData: 600/180/280/null//
          outgoingConnections: []
        '[image]:image "Image"':
          data:
            useDataInput: false
            mediaType: image/png
            useMediaTypeInput: false
          visualData: 160/500/250/null//
          outgoingConnections: []
  plugins:
    - type: built-in
      id: typesafe
      name: TypeSafe AI (Jev)
  references: []
`;

const project: WorkflowProjectItem = {
  id: 'hosted-jev-node-family',
  projectMetadataId: 'hosted-jev-node-family',
  name: projectName,
  fileName: `${projectName}.rivet-project`,
  relativePath: `${projectName}.rivet-project`,
  absolutePath: projectPath,
  updatedAt: '2026-09-19T00:00:00.000Z',
  settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
};

async function openFixture(page: Page): Promise<FrameLocator> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/config' && request.method() === 'GET') {
      await route.fulfill({
        json: {
          executorWsUrl: 'ws://127.0.0.1:8081/ws/executor/internal',
          remoteDebuggerDefaultWs: 'ws://127.0.0.1:8081/ws/latest-debugger',
          publishedWorkflowsBasePath: '/workflows',
          latestWorkflowsBasePath: '/workflows-latest',
          publishedAppsBasePath: '/apps',
          latestAppsBasePath: '/apps-latest',
          webAppsAuthMode: 'ui-gate',
        },
      });
    } else if (path === '/api/workflows/evaluation-runs/library' && request.method() === 'GET') {
      await route.fulfill({
        json: {
          revision: 0,
          resourceVersions: { suites: {}, datasets: {} },
          library: {
            version: 1,
            data: { version: 1, suites: [], baselines: [] },
            datasets: [],
            migratedLegacyProjectIds: [],
          },
        },
      });
    } else if (path === '/api/workflows/tree' && request.method() === 'GET') {
      const tree: WorkflowTreeResponse = {
        root: '/workflows',
        sync: { epoch: 'jev', revision: 0 },
        folders: [],
        projects: [project],
      };
      await route.fulfill({ json: tree });
    } else if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents: fixture, datasetsContents: null, revisionId: null } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      await route.abort('blockedbyclient');
    } else {
      await route.fallback();
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  await page.locator('.project-row', { hasText: projectName }).dblclick();
  const editor = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(editor.getByRole('dialog').filter({ hasText: 'Project Plugins Not Installed' })).toHaveCount(0);
  await expect(editor.locator('.node[data-nodeid="choice"]')).toBeVisible({ timeout: 60_000 });
  return editor;
}

async function selectQuestionType(editor: FrameLocator, questionType: 'Noul' | 'Choice' | 'Score') {
  const selector = editor.getByRole('group', { name: 'Question type', exact: true });
  const option = selector.getByRole('button', { name: questionType, exact: true });

  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
}

function classifierSection(editor: FrameLocator, heading: 'Instructions' | 'Criteria') {
  return editor.getByRole('heading', { name: heading, exact: true }).locator('..');
}

test('Classifier configuration exports a wired profile and suspension administration is family scoped', async ({
  page,
}) => {
  const editor = await openFixture(page);
  const evaluate = editor.locator('.node[data-nodeid="evaluate"]');
  await evaluate.locator('button.edit-button').dispatchEvent('click');
  await expect(editor.getByRole('group', { name: 'Classifier configuration source' })).toBeVisible();
  await editor.getByRole('button', { name: 'From profile', exact: true }).click();
  await expect(evaluate.locator('.port-label', { hasText: /^Classifier Profiles$/ })).toHaveCount(1);
  await expect(editor.getByRole('group', { name: 'API key source' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Inline', exact: true }).click();
  await editor.getByRole('button', { name: 'Export Classifier settings to profile node', exact: true }).click();
  const profileNode = editor
    .locator('.node')
    .filter({ hasText: 'Classifier Profile' })
    .filter({ has: editor.locator('.port-label', { hasText: /^Profile$/ }) });
  await expect(profileNode).toHaveCount(1);
  await expect(evaluate).toContainText('From profile');
  const profileId = await profileNode.getAttribute('data-nodeid');
  await editor.locator('body').press('ControlOrMeta+z');
  await expect(profileNode).toHaveCount(0);
  await expect(evaluate.locator('.port-label', { hasText: /^Classifier Profiles$/ })).toHaveCount(0);
  await editor.locator('body').press('ControlOrMeta+Shift+z');
  await expect(profileNode).toHaveCount(1);
  await expect(profileNode).toHaveAttribute('data-nodeid', profileId!);
  await expect(evaluate.locator('.port-label', { hasText: /^Classifier Profiles$/ })).toHaveCount(1);
  await expect(profileNode).toContainText('Automatic suspension: Disabled');
  await profileNode.locator('button.edit-button').dispatchEvent('click');
  await expect(editor.getByRole('group', { name: 'API key source' })).toBeVisible();
  await expect(editor.getByText('Response timeout (seconds)', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const families: string[] = [];
  await page.route('**/api/workflows/llm-profile-health/admin?**', async (route) => {
    families.push(new URL(route.request().url()).searchParams.get('family')!);
    await route.fulfill({ json: [] });
  });
  await page.locator('.project-row', { hasText: projectName }).click();
  await page.locator('.active-project-more-button').click();
  const modal = page.locator('[data-testid="workflow-project-settings-modal"]');
  await modal.getByRole('tab', { name: 'Classifier profile suspension', exact: true }).click();
  await expect(
    modal.getByText('No Classifier profiles are currently suspended or awaiting recovery.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => families).toEqual(['classifier']);
  await modal.getByRole('tab', { name: 'LLM profile suspension', exact: true }).click();
  await expect(
    modal.getByText('No LLM profiles are currently suspended or awaiting recovery.', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => families).toEqual(['classifier', 'llm']);
});

async function expectNoExtraEditorGap(control: Locator, content: Locator) {
  await expect
    .poll(async () => {
      const [controlBox, contentBox] = await Promise.all([control.boundingBox(), content.boundingBox()]);
      return controlBox && contentBox ? contentBox.y - (controlBox.y + controlBox.height) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(30);
}

test('Classifier Profile copy/paste preserves provider configuration and creates a new source identity', async ({
  page,
}) => {
  const editor = await openFixture(page);
  await editor.locator('.node[data-nodeid="evaluate"] button.edit-button').dispatchEvent('click');
  await editor.getByRole('button', { name: 'Export Classifier settings to profile node', exact: true }).click();
  const profiles = editor.locator('.node').filter({ has: editor.locator('.port-label', { hasText: /^Profile$/ }) });
  await expect(profiles).toHaveCount(1);
  const first = profiles.first();
  const originalId = await first.getAttribute('data-nodeid');
  await first.locator('button.edit-button').dispatchEvent('click');
  const provider = editor.getByRole('combobox', { name: 'Provider', exact: true });
  await provider.fill('Liquid AI');
  await provider.press('Enter');
  const model = editor.getByRole('textbox', { name: 'Model', exact: true });
  await model.fill('');
  await model.blur();
  await expect(first).toContainText('Model: d1');
  await page.keyboard.press('Escape');
  await first.locator('.node-title').click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(profiles).toHaveCount(2);
  const ids = await profiles.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-nodeid')));
  expect(ids).toContain(originalId);
  expect(new Set(ids).size).toBe(2);
  for (const profile of await profiles.all()) {
    await expect(profile).toContainText('Provider: Liquid AI');
    await expect(profile).toContainText('Model: d1');
    await expect(profile).toContainText('Automatic suspension: Disabled');
  }
});

async function expectInputToggleOnRight(field: Locator) {
  const content = field.locator(':scope > :first-child');
  const toggle = field.locator(':scope > .use-input-toggle');

  await expect(toggle).toBeVisible();
  await expect
    .poll(async () => {
      const [contentBox, toggleBox] = await Promise.all([content.boundingBox(), toggle.boundingBox()]);
      return contentBox && toggleBox ? toggleBox.x - (contentBox.x + contentBox.width) : Number.NEGATIVE_INFINITY;
    })
    .toBeGreaterThanOrEqual(8);
}

async function expectClassifierBodyUsesLlmLayout(node: Locator) {
  const sections = node.locator('.llm-node-body-section');

  await expect(node.locator('.node-body-markdown')).toHaveCount(0);
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(1)).toHaveCSS('border-top-width', '1px');
  await expect(sections.nth(1)).toHaveCSS('margin-top', '8px');
  await expect(sections.nth(1)).toHaveCSS('padding-top', '8px');
}

test('Choice selection persists and keeps both criteria columns usable', async ({ page }) => {
  const editor = await openFixture(page);
  const choice = editor.locator('.node[data-nodeid="choice"]');
  await choice.hover();
  await choice.locator('button.edit-button').click({ force: true });

  await selectQuestionType(editor, 'Score');
  await expect(
    classifierSection(editor, 'Criteria').getByRole('combobox', { name: 'Criteria type', exact: true }),
  ).toBeVisible();
  await expect(editor.getByRole('combobox', { name: 'Criterion 1 type', exact: true })).toHaveCount(0);

  await selectQuestionType(editor, 'Choice');
  await expect(choice).toContainText('Type: Choice');

  const choiceCriteriaEditor = editor.locator('.row.keyValuePair');
  const firstName = choiceCriteriaEditor.getByPlaceholder('Name').first();
  const firstDescription = choiceCriteriaEditor.getByPlaceholder('Optional description').first();
  await expect(firstName).toBeVisible();
  await expect(firstDescription).toBeVisible();
  await expect
    .poll(async () => {
      const [nameBox, descriptionBox] = await Promise.all([firstName.boundingBox(), firstDescription.boundingBox()]);
      return nameBox && descriptionBox ? descriptionBox.width / nameBox.width : 0;
    })
    .toBeGreaterThan(0.8);
  await expectInputToggleOnRight(choiceCriteriaEditor);

  const instructionsSection = classifierSection(editor, 'Instructions');
  const instructionsType = instructionsSection.getByRole('combobox', { name: 'Instructions type', exact: true });
  await expect(instructionsSection.getByText('Type', { exact: true })).toHaveCount(0);
  await instructionsType.click();
  await instructionsType.fill('List of lines');
  await instructionsType.press('Enter');
  const instructionList = instructionsSection.locator('.row.stringList');
  await expect(choice).toContainText('Instructions: 1 lines');
  await expect(instructionList).toBeVisible();
  await expectNoExtraEditorGap(instructionsType, instructionList);
  await instructionList.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(instructionList.getByRole('button', { name: 'Reorder item' })).toHaveCount(2);

  await instructionsType.click();
  await instructionsType.fill('Object');
  await instructionsType.press('Enter');
  await expect(choice).toContainText('Instructions: object');
  const objectInstructions = instructionsSection.locator('.row.code');
  await expect(objectInstructions).toBeVisible();
  await expectNoExtraEditorGap(instructionsType, objectInstructions);

  await instructionsType.click();
  await instructionsType.fill('List of lines');
  await instructionsType.press('Enter');
  await expect(choice).toContainText('Instructions: 2 lines');
});

test('Classifier Criteria input-source control stays in the trailing grid column', async ({ page }) => {
  const editor = await openFixture(page);
  const choice = editor.locator('.node[data-nodeid="choice"]');
  await choice.hover();
  await choice.locator('button.edit-button').click({ force: true });

  const criteriaSection = classifierSection(editor, 'Criteria');
  const criteriaType = criteriaSection.getByRole('combobox', { name: 'Criteria type', exact: true });
  const choiceTextCriteria = criteriaSection.locator('.row.keyValuePair.has-side-control');
  await expectInputToggleOnRight(choiceTextCriteria);

  await criteriaType.click();
  await criteriaType.fill('Object');
  await criteriaType.press('Enter');
  const choiceObjectCriteria = criteriaSection.locator('.row.custom.has-side-control');
  await expect(choiceObjectCriteria.locator('.monaco-editor')).toHaveCount(2);
  await expectInputToggleOnRight(choiceObjectCriteria);

  await selectQuestionType(editor, 'Score');
  await criteriaType.click();
  await criteriaType.fill('Text');
  await criteriaType.press('Enter');
  const scoreTextCriteria = criteriaSection.locator('.row.custom.has-side-control');
  await expect(scoreTextCriteria.getByPlaceholder('Name')).toHaveCount(2);
  await expectInputToggleOnRight(scoreTextCriteria);
});

test('Classifier cards share the LLM Chat body layout', async ({ page }) => {
  const editor = await openFixture(page);
  const choice = editor.locator('.node[data-nodeid="choice"]');
  const evaluate = editor.locator('.node[data-nodeid="evaluate"]');

  await expectClassifierBodyUsesLlmLayout(choice);
  await expect(choice.locator('.llm-node-body-label')).toHaveText(['Type:', 'ID:', 'Criteria:']);
  await expect(choice.locator('.llm-node-body-label').first()).toHaveCSS('opacity', '0.6');

  await expect(evaluate.locator('.node-body-markdown')).toHaveCount(0);
  await expect(evaluate.locator('.llm-node-body-section')).toHaveCount(2);
  await expect(evaluate.locator('.llm-node-body-label')).toHaveText(['Provider:', 'Model:', 'Throw on non-2XX:']);
  await expect(evaluate.locator('.llm-node-body-label').first()).toHaveCSS('opacity', '0.6');
});

test('legacy Jev projects migrate to built-in Classifier nodes without installing a plugin', async ({ page }) => {
  const editor = await openFixture(page);
  const choice = editor.locator('.node[data-nodeid="choice"]');
  await expect(choice).toContainText('Type: Choice');
  await expect(choice).toContainText('ID: route');
  await expect(choice).toContainText('Route {{subject}}');
  const choiceBodyFields = choice.locator('.llm-node-body-label');
  await expect(choiceBodyFields).toHaveText(['Type:', 'ID:', 'Criteria:']);
  await expect(choiceBodyFields.first()).toHaveCSS('opacity', '0.6');
  await expectClassifierBodyUsesLlmLayout(choice);
  await expect(choice.locator('.port-label', { hasText: /^subject$/ })).toHaveCount(1);

  await choice.hover();
  await choice.locator('button.edit-button').click({ force: true });
  await expect(editor.getByText('Question type', { exact: true })).toBeVisible();
  await expect(editor.getByText('Question ID', { exact: true })).toBeVisible();
  const instructionsSection = classifierSection(editor, 'Instructions');
  await expect(instructionsSection.getByRole('combobox', { name: 'Instructions type', exact: true })).toBeVisible();
  await expect(instructionsSection.getByText('Type', { exact: true })).toHaveCount(0);
  await expect(editor.getByRole('heading', { name: 'Criteria', exact: true })).toBeVisible();
  const choiceCriteriaEditor = editor.locator('.row.keyValuePair');
  await expect(choiceCriteriaEditor.getByPlaceholder('Name')).toHaveCount(2);
  await expect(choiceCriteriaEditor.getByPlaceholder('Optional description')).toHaveCount(2);
  await expect(editor.getByRole('button', { name: 'Reorder criterion' })).toHaveCount(2);
  await expect(editor.getByRole('button', { name: 'Add criterion', exact: true })).toBeVisible();

  await expect(editor.getByRole('group', { name: 'Question type', exact: true })).toBeVisible();
  await selectQuestionType(editor, 'Score');
  const criteriaSection = classifierSection(editor, 'Criteria');
  const criteriaType = criteriaSection.getByRole('combobox', { name: 'Criteria type', exact: true });
  await expect(criteriaType).toBeVisible();
  await expect(criteriaSection.getByText('Type', { exact: true })).toHaveCount(0);
  await expect(criteriaSection.getByText('Criterion 1', { exact: true })).toHaveCount(0);
  await expect(criteriaSection.getByPlaceholder('Name')).toHaveCount(2);
  await expect(criteriaSection.locator('.monaco-editor')).toHaveCount(0);
  await expect(editor.getByRole('combobox', { name: 'Criterion 1 type', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Add criterion', exact: true })).toBeVisible();
  await criteriaType.click();
  await criteriaType.fill('List of lines');
  await criteriaType.press('Enter');
  await expect(editor.getByRole('group', { name: 'Criterion 1 lines' })).toBeVisible();
  await criteriaType.click();
  await criteriaType.fill('Object');
  await criteriaType.press('Enter');
  await expect(criteriaSection.getByText('Criterion 1 object', { exact: true })).toHaveCount(0);
  await expect(criteriaSection.locator('.editor-wrapper-wrapper').first()).toBeVisible();

  await selectQuestionType(editor, 'Noul');
  await expect(criteriaSection.getByText('true', { exact: true })).toBeVisible();
  await expect(criteriaSection.getByText('false', { exact: true })).toBeVisible();
  const trueInputToggle = editor.getByRole('button', { name: 'Use an input port for true' });
  const falseInputToggle = editor.getByRole('button', { name: 'Use an input port for false' });
  await expect(trueInputToggle).toBeVisible();
  await expect(falseInputToggle).toBeVisible();
  await trueInputToggle.click();
  await falseInputToggle.click();
  await expect(choice.locator('.port-label', { hasText: /^true$/ })).toHaveCount(1);
  await expect(choice.locator('.port-label', { hasText: /^false$/ })).toHaveCount(1);
  await expect(editor.getByText('Yes means', { exact: true })).toHaveCount(0);
  await expect(editor.getByText('No means', { exact: true })).toHaveCount(0);

  await criteriaType.click();
  await criteriaType.fill('List of lines');
  await criteriaType.press('Enter');
  await expect(criteriaSection.getByText('true', { exact: true })).toBeVisible();
  await expect(criteriaSection.getByText('false', { exact: true })).toBeVisible();

  await selectQuestionType(editor, 'Choice');
  await criteriaType.click();
  await criteriaType.fill('Text');
  await criteriaType.press('Enter');
  await expect(choice).toContainText('Type: Choice');
  const firstName = choiceCriteriaEditor.getByPlaceholder('Name').first();
  const firstDescription = choiceCriteriaEditor.getByPlaceholder('Optional description').first();
  await expect(firstName).toBeVisible();
  await expect(firstDescription).toBeVisible();
  await expect
    .poll(async () => {
      const [nameBox, descriptionBox] = await Promise.all([firstName.boundingBox(), firstDescription.boundingBox()]);
      return nameBox && descriptionBox ? descriptionBox.width / nameBox.width : 0;
    })
    .toBeGreaterThan(0.8);
  const evaluate = editor.locator('.node[data-nodeid="evaluate"]');
  await expect(evaluate.locator('.port-label', { hasText: /^Question 1$/ })).toHaveCount(1);
  await expect(evaluate.locator('.port-label', { hasText: /^Answers$/ })).toHaveCount(1);
  await expect(evaluate.locator('.port-label', { hasText: /^Cost$/ })).toHaveCount(1);
  await expect(evaluate.locator('.port-label', { hasText: /^Model$/ })).toHaveCount(0);
  await expect(evaluate).not.toContainText('Batch: one request');
  const evaluateBodyFields = evaluate.locator('.llm-node-body-label');
  await expect(evaluateBodyFields).toHaveText(['Provider:', 'Model:', 'Throw on non-2XX:']);
  await expect(evaluateBodyFields.first()).toHaveCSS('opacity', '0.6');
  await expect(evaluate).toContainText('Provider: Jev');
  await expect(evaluate).toContainText('Model: jev-latest');

  // The inspector intentionally stays open until Escape. Dispatch the next node's
  // edit action so this assertion exercises switching inspectors instead of relying
  // on page-level keyboard focus across the editor iframe.
  await evaluate.locator('button.edit-button').dispatchEvent('click');
  const modelSection = editor.getByRole('button', { name: 'Model', exact: true }).and(editor.locator('button'));
  const modelContent = modelSection
    .locator('xpath=ancestor::div[@class="Collapsible"][1]')
    .locator(':scope > .Collapsible__contentOuter');
  await expect(modelSection).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.getByText('Provider', { exact: true })).toBeVisible();
  await expect(editor.getByRole('group', { name: 'API key source' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Automatic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('input[value="typesafeApiKey"]')).toBeVisible();
  await expect(editor.locator('input[value="TYPESAFE_API_KEY"]')).toBeVisible();
  await modelSection.click();
  await expect(modelSection).toHaveAttribute('aria-expanded', 'false');
  // react-collapsible clips mounted controls rather than display:none-ing them;
  // Playwright's toBeVisible does not account for this ancestor clipping.
  await expect(modelContent).toHaveCSS('height', '0px');
  await expect(modelContent).toHaveCSS('overflow', 'hidden');
  await expect(modelContent.getByText('Provider', { exact: true })).toHaveCount(1);
  await expect(modelContent.getByRole('group', { name: 'API key source' })).toHaveCount(1);
  await modelSection.click();
  await expect(modelSection).toHaveAttribute('aria-expanded', 'true');
  await expect(editor.getByText('Provider', { exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Automatic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('button', { name: 'Classifier settings', exact: true }).click();
  await expect(editor.locator('input[value="typesafeApiKey"]')).toHaveCount(0);
  await expect(editor.getByText(/Does not fall back to named or environment credentials/)).toBeVisible();
  await expect(evaluate.locator('.port-label', { hasText: /^API Key$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await evaluate.locator('button.edit-button').dispatchEvent('click');
  await expect(editor.getByRole('button', { name: 'Classifier settings', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await editor.getByRole('button', { name: 'Automatic', exact: true }).click();
  await expect(editor.locator('input[value="typesafeApiKey"]')).toBeVisible();
  await expect(editor.getByText('Outputs', { exact: true })).toBeVisible();
  const outputsHeading = editor.getByText('Outputs', { exact: true });
  if (
    (await outputsHeading.locator('xpath=ancestor::*[@aria-expanded][1]').getAttribute('aria-expanded')) === 'false'
  ) {
    await outputsHeading.click();
  }
  await expect(editor.getByText('Output usage details', { exact: true })).toBeVisible();
  await expect(editor.getByText('Output request body', { exact: true })).toBeVisible();
  await expect(editor.getByText('Output response body', { exact: true })).toBeVisible();
  await editor.getByText('Output usage details', { exact: true }).click();
  await expect(editor.locator('input#outputUsage')).toBeChecked();
  await editor.getByText('Output request body', { exact: true }).click();
  await expect(evaluate.locator('.port-label', { hasText: /^Request body$/ })).toHaveCount(1);
  await editor.getByText('Output response body', { exact: true }).click();
  await expect(evaluate.locator('.port-label', { hasText: /^Response body$/ })).toHaveCount(1);
  await expect(editor.getByText('Error behavior', { exact: true })).toBeVisible();
  const errorHeading = editor.getByText('Error behavior', { exact: true });
  if ((await errorHeading.locator('xpath=ancestor::*[@aria-expanded][1]').getAttribute('aria-expanded')) === 'false') {
    await errorHeading.click();
  }
  await expect(editor.getByText('Retry on non-200', { exact: true })).toBeVisible();
  await editor.getByText('Retry on non-200', { exact: true }).click();
  await expect(editor.getByText('Repeat times', { exact: true })).toBeVisible();
  await expect(editor.getByText('Cooldown, ms', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Input port', exact: true }).click();
  await expect(evaluate.locator('.port-label', { hasText: /^API Key$/ })).toHaveCount(1);
  await expect(editor.locator('input[value="typesafeApiKey"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Classifier nodes are available from the built-in Classifier add-node group', async ({ page }) => {
  const editor = await openFixture(page);
  const canvas = editor.locator('.node-canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await canvas.click({ button: 'right', position: { x: bounds!.width - 40, y: Math.min(500, bounds!.height - 40) } });

  const addNode = editor.locator('.context-menu-label-text', { hasText: 'Add node' });
  await expect(addNode).toHaveText('Add node');
  await addNode.hover();

  const classifierGroup = editor.getByText('Classifier', { exact: true });
  await expect(classifierGroup).toBeVisible();
  await classifierGroup.hover();
  await expect(editor.locator('.context-menu-label-text', { hasText: 'Classifier Question' })).toHaveText(
    'Classifier Question',
  );
  await expect(editor.locator('.context-menu-label-text', { hasText: 'Classifier Evaluate' })).toHaveText(
    'Classifier Evaluate',
  );
});

test('Liquid AI selection exposes d1 and independent configured credentials without changing questions', async ({
  page,
}) => {
  const editor = await openFixture(page);
  const evaluate = editor.locator('.node[data-nodeid="evaluate"]');
  const choice = editor.locator('.node[data-nodeid="choice"]');
  await evaluate.locator('button.edit-button').dispatchEvent('click');
  const provider = editor.getByRole('combobox', { name: 'Provider', exact: true });
  await provider.fill('Liquid AI');
  await provider.press('Enter');
  await expect(evaluate).toContainText('Provider: Liquid AI');
  // This migrated legacy node pins jev-latest. Switching provider must not
  // silently rewrite that explicit contract; clearing it selects Liquid's default.
  const model = editor.getByRole('textbox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('jev-latest');
  await model.fill('');
  await model.blur();
  await expect(model).toHaveAttribute('placeholder', 'd1');
  await expect(evaluate).toContainText('Model: d1');
  await expect(editor.locator('input[value="liquidApiKey"]')).toBeVisible();
  await expect(editor.locator('input[value="LIQUID_API_KEY"]')).toBeVisible();
  await expect(editor.locator('input[value="TYPESAFE_API_KEY"]')).toHaveCount(0);
  await expect(choice).toContainText('Type: Choice');
  await expect(choice).toContainText('Route {{subject}}');

  const programmaticName = editor.getByRole('textbox', { name: 'Programmatic API key name', exact: true });
  await programmaticName.fill('myLiquidKey');
  await programmaticName.blur();
  await provider.fill('Jev');
  await provider.press('Enter');
  await expect(editor.locator('input[value="typesafeApiKey"]')).toBeVisible();
  await expect(evaluate).toContainText('Model: jev-latest');
  await provider.fill('Liquid AI');
  await provider.press('Enter');
  await expect(programmaticName).toHaveValue('myLiquidKey');
  await expect(evaluate).toContainText('Model: d1');
});

test('OpenAI Decisions selection exposes its model, credentials and single multimodal State input', async ({
  page,
}) => {
  const editor = await openFixture(page);
  const evaluate = editor.locator('.node[data-nodeid="evaluate"]');
  const choice = editor.locator('.node[data-nodeid="choice"]');
  await expect(evaluate.locator('.port-label', { hasText: /^Images$/ })).toHaveCount(0);
  await expect(evaluate.locator('.port-label', { hasText: /^State$/ })).toHaveCount(1);
  await expect(choice.locator('.port-label', { hasText: /^Images$/ })).toHaveCount(0);
  await evaluate.locator('button.edit-button').dispatchEvent('click');
  const provider = editor.getByRole('combobox', { name: 'Provider', exact: true });
  await provider.fill('OpenAI');
  await provider.press('Enter');
  const model = editor.getByRole('textbox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('jev-latest');
  await model.fill('');
  await model.blur();
  await expect(model).toHaveAttribute('placeholder', 'gpt-6-luna');
  await expect(evaluate).toContainText('Provider: OpenAI');
  await expect(evaluate).toContainText('Model: gpt-6-luna');
  await expect(editor.locator('input[value="openAiApiKey"]')).toBeVisible();
  await expect(editor.locator('input[value="OPENAI_API_KEY"]')).toBeVisible();
  await expect(editor.locator('input[value="LIQUID_API_KEY"]')).toHaveCount(0);
  await choice.locator('button.edit-button').dispatchEvent('click');
  await expect(editor.getByText('Question images', { exact: true })).toHaveCount(0);
  await expect(editor.locator('input#useImagesInput')).toHaveCount(0);
  await expect(choice).toContainText('Route {{subject}}');
  await expect(choice.locator('.port-label', { hasText: /^Images$/ })).toHaveCount(0);
});

test('Classifier failure ports follow Catch all failures independently of the HTTP status toggle', async ({ page }) => {
  const editor = await openFixture(page);
  const evaluate = editor.locator('.node[data-nodeid="evaluate"]');
  await evaluate.locator('button.edit-button').dispatchEvent('click');
  await editor.getByText('Error behavior', { exact: true }).click();
  const catchFailures = editor.locator('input#catchRequestFailed');
  const failHttp = editor.locator('input#errorOnNon200');
  const failurePorts = evaluate.locator('.port-label', { hasText: /^(Run failed|Run error)$/ });
  await expect(failurePorts).toHaveCount(0);
  await failHttp.locator('..').click();
  await expect(failHttp).not.toBeChecked();
  await expect(failurePorts).toHaveCount(0);
  await catchFailures.locator('..').click();
  await expect(catchFailures).toBeChecked();
  await expect(failurePorts).toHaveCount(2);
  await failHttp.locator('..').click();
  await expect(failHttp).toBeChecked();
  await expect(failurePorts).toHaveCount(2);
  await catchFailures.locator('..').click();
  await expect(catchFailures).not.toBeChecked();
  await expect(failurePorts).toHaveCount(0);
  await failHttp.locator('..').click();
  await expect(failHttp).not.toBeChecked();
  await expect(failurePorts).toHaveCount(0);
});

test('Image file selection infers Media Type from the selected filename, including JPEG extensions', async ({
  page,
}) => {
  // Exercise the ordinary browser file-input fallback rather than the OS picker.
  await page.addInitScript(() => {
    delete (window as any).showOpenFilePicker;
  });
  const editor = await openFixture(page);
  const image = editor.locator('.node[data-nodeid="image"]');
  await image.locator('button.edit-button').dispatchEvent('click');
  const imageBytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    return {
      jpeg: canvas.toDataURL('image/jpeg').split(',')[1]!,
      png: canvas.toDataURL('image/png').split(',')[1]!,
    };
  });

  for (const file of [
    { name: 'photo.JPG', mimeType: 'image/jpeg', encoded: imageBytes.jpeg, label: 'JPEG' },
    { name: 'photo.jpeg', mimeType: 'image/jpeg', encoded: imageBytes.jpeg, label: 'JPEG' },
    { name: 'photo.png', mimeType: 'image/png', encoded: imageBytes.png, label: 'PNG' },
    {
      name: 'photo.gif',
      mimeType: 'image/gif',
      encoded: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      label: 'GIF',
    },
  ]) {
    const chooser = page.waitForEvent('filechooser');
    await editor.getByRole('button', { name: 'Pick Image', exact: true }).click();
    await (
      await chooser
    ).setFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.encoded, 'base64') });
    await expect(image).toContainText(`Media Type: ${file.label}`);
    await expect(editor.getByText('Image selected', { exact: true })).toBeVisible();
  }
});
