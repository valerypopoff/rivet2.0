import { expect, test } from '@playwright/test';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

const projectName = 'Subgraph prompt cancellation';
const projectPath = `/workflows/${projectName}.rivet-project`;
const currentPrompt = 'Still-running prompt?';
const cancelledPrompt = 'Cancelled race prompt';

// The delay gives the first User Input time to start. Correctness is observed
// through the second prompt, not an assertion about how quickly the race ends.
const contents = `version: 4
data:
  metadata:
    id: prompt-cancellation-project
    title: "${projectName}"
    description: ""
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[caller]:subGraph "Selected prompt caller"':
          data:
            graphId: child
            skipUnusedOutputs: true
          visualData: 400/220/260/null//
          outgoingConnections:
            - requested->"Result" result/value
        '[result]:graphOutput "Result"':
          data:
            id: result
            dataType: string[]
          visualData: 860/220/240/null//
    child:
      metadata:
        id: child
        name: Prompt Child
      nodes:
        '[loser]:userInput "Losing prompt"':
          data:
            prompt: "${cancelledPrompt}"
            useInput: false
          visualData: 0/0/250/null//
          outgoingConnections:
            - output->"Race" race/input1
        '[question]:text "Next question"':
          data:
            text: "${currentPrompt}"
          visualData: 0/300/250/null//
          outgoingConnections:
            - output->"Delay winner" delayed/input1
        '[delayed]:delay "Delay winner"':
          data:
            delay: 500
          visualData: 350/300/200/null//
          outgoingConnections:
            - output1->"Race" race/input2
        '[race]:raceInputs "Race"':
          data: {}
          visualData: 650/100/220/null//
          outgoingConnections:
            - result->"Current prompt" current/questions
        '[current]:userInput "Current prompt"':
          data:
            prompt: ""
            useInput: true
          visualData: 950/100/250/null//
          outgoingConnections:
            - output->"Requested output" requested/value
        '[requested]:graphOutput "Requested output"':
          data:
            id: requested
            dataType: string[]
          visualData: 1300/100/240/null//
        '[unused-text]:text "Unused text"':
          data:
            text: unused-result
          visualData: 0/650/250/null//
          outgoingConnections:
            - output->"Unused output" unused/value
        '[unused]:graphOutput "Unused output"':
          data:
            id: unused
            dataType: string
          visualData: 350/650/240/null//
  plugins: []
  references: []
`;

test('a cancelled selected-child prompt gives way to the live prompt and leaves no stale modal', async ({ page }) => {
  test.slow();
  const unexpectedMutations: string[] = [];
  const project: WorkflowProjectItem = {
    id: 'prompt-cancellation-project',
    name: projectName,
    fileName: `${projectName}.rivet-project`,
    relativePath: `${projectName}.rivet-project`,
    absolutePath: projectPath,
    updatedAt: '2026-09-05T00:00:00.000Z',
    settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
  };
  await page.addInitScript(() => {
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/workflows/tree' && request.method() === 'GET') {
      const tree: WorkflowTreeResponse = {
        root: '/workflows',
        sync: { epoch: 'prompt-cancellation-fixture', revision: 0 },
        folders: [],
        projects: [project],
      };
      await route.fulfill({ json: tree });
    } else if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      unexpectedMutations.push(`${request.method()} ${path}`);
      await route.abort('blockedbyclient');
    } else {
      await route.fallback();
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const row = page.locator('.project-row', { hasText: projectName });
  await expect(row).toBeEnabled({ timeout: 90_000 });
  await row.dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const caller = frame.locator('.node[data-nodeid="caller"]');
  await expect(caller).toBeVisible({ timeout: 90_000 });
  const modal = frame.getByRole('dialog', { name: 'User Input', exact: true });
  const runButton = frame.locator('.run-button button').first();
  const promptButton = frame.getByRole('button', { name: 'User Input Needed', exact: true });

  const runUntilCurrentPrompt = async () => {
    await runButton.click();
    await expect(modal.locator('.question')).toHaveText(currentPrompt);
    await expect(modal).not.toContainText(cancelledPrompt);
    await expect(frame.locator('.run-button.running button').first()).toContainText('Abort');
  };

  await test.step('Only the still-running request is answerable after the race loser is cancelled', async () => {
    await runUntilCurrentPrompt();
    await modal.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(caller).toHaveClass(/success/);
    await expect(modal).toBeHidden();
    await expect(promptButton).toBeHidden();
    await caller.hover();
    await expect(caller.locator('.node-output')).toContainText('Not ran');
    await expect(caller.locator('.node-output')).not.toContainText('unused-result');
  });

  await test.step('A later Stop also clears the outstanding request and reopen button', async () => {
    await runUntilCurrentPrompt();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(promptButton).toBeVisible();
    await frame.getByRole('button', { name: 'Abort', exact: true }).first().click();
    await expect(frame.locator('.run-button.running')).toHaveCount(0);
    await expect(modal).toBeHidden();
    await expect(promptButton).toBeHidden();
  });

  expect(unexpectedMutations).toEqual([]);
});
