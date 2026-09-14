import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  deserializeProject,
  serializeProject,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeGraph,
  type Project,
} from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem, WorkflowTreeResponse } from '../dashboard/types';

const projectName = 'Graph port rename';
const projectPath = `/workflows/${projectName}.rivet-project`;
const shortcutModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

const fixture = `version: 4
data:
  metadata:
    id: graph-port-rename
    title: "${projectName}"
    description: ""
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[source-old]:text "Old source"':
          data:
            text: old source
          visualData: 80/120/220/null//
          outgoingConnections:
            - output->"Child caller" caller/old-input
        '[source-occupied]:text "Occupied source"':
          data:
            text: occupied source
          visualData: 80/260/220/null//
          outgoingConnections:
            - output->"Child caller" caller/occupied-input
        '[source-unrelated]:text "Unrelated source"':
          data:
            text: unrelated source
          visualData: 80/400/220/null//
          outgoingConnections:
            - output->"Child caller" caller/unrelated-input
        '[caller]:subGraph "Child caller"':
          data:
            graphId: child
            inputData:
              old-input:
                type: string
                value: old default
              occupied-input:
                type: string
                value: occupied default
              unrelated-input:
                type: string
                value: unrelated default
            inputPortOrder:
              - unrelated-input
              - occupied-input
              - old-input
            outputPortOrder:
              - unrelated-output
              - occupied-output
              - old-output
          visualData: 480/240/280/null//
          outgoingConnections:
            - occupied-output->"Output target A __rivet_bend:41,17" output-target-a/input
            - old-output->"Output target A" output-target-a/input
            - old-output->"Output target B" output-target-b/input
            - unrelated-output->"Unrelated target" unrelated-target/input
        '[output-target-a]:text "Output target A"':
          data:
            text: target a
          visualData: 900/160/220/null//
        '[output-target-b]:text "Output target B"':
          data:
            text: target b
          visualData: 900/300/220/null//
        '[unrelated-target]:text "Unrelated target"':
          data:
            text: unrelated target
          visualData: 900/440/220/null//
    child:
      metadata:
        id: child
        name: Child Graph
      nodes:
        '[child-input]:graphInput "Child input"':
          data:
            id: old-input
            dataType: string
          visualData: 80/80/220/null//
        '[existing-input]:graphInput "Existing input"':
          data:
            id: occupied-input
            dataType: string
          visualData: 80/180/220/null//
        '[unrelated-input]:graphInput "Unrelated input"':
          data:
            id: unrelated-input
            dataType: string
          visualData: 80/280/220/null//
        '[child-output]:graphOutput "Child output"':
          data:
            id: old-output
            dataType: string
          visualData: 920/80/220/null//
        '[existing-output]:graphOutput "Existing output"':
          data:
            id: occupied-output
            dataType: string
          visualData: 920/180/220/null//
        '[unrelated-output]:graphOutput "Unrelated output"':
          data:
            id: unrelated-output
            dataType: string
          visualData: 920/280/220/null//
        '[recursive-source-old]:text "Recursive old source"':
          data:
            text: recursive old source
          visualData: 80/470/220/null//
          outgoingConnections:
            - output->"Recursive caller" recursive/old-input
        '[recursive-source-occupied]:text "Recursive occupied source"':
          data:
            text: recursive occupied source
          visualData: 80/590/220/null//
          outgoingConnections:
            - output->"Recursive caller" recursive/occupied-input
        '[recursive-source-unrelated]:text "Recursive unrelated source"':
          data:
            text: recursive unrelated source
          visualData: 80/710/220/null//
          outgoingConnections:
            - output->"Recursive caller" recursive/unrelated-input
        '[recursive]:subGraph "Recursive caller"':
          data:
            graphId: child
            inputData:
              old-input:
                type: string
                value: recursive old default
              occupied-input:
                type: string
                value: recursive occupied default
              unrelated-input:
                type: string
                value: recursive unrelated default
            inputPortOrder:
              - unrelated-input
              - occupied-input
              - old-input
            outputPortOrder:
              - unrelated-output
              - occupied-output
              - old-output
          visualData: 440/580/280/null//
          outgoingConnections:
            - occupied-output->"Recursive target A __rivet_bend:23,29" recursive-target-a/input
            - old-output->"Recursive target A" recursive-target-a/input
            - old-output->"Recursive target B" recursive-target-b/input
            - unrelated-output->"Recursive unrelated target" recursive-unrelated-target/input
        '[recursive-target-a]:text "Recursive target A"':
          data:
            text: recursive target a
          visualData: 820/470/220/null//
        '[recursive-target-b]:text "Recursive target B"':
          data:
            text: recursive target b
          visualData: 820/590/220/null//
        '[recursive-unrelated-target]:text "Recursive unrelated target"':
          data:
            text: recursive unrelated target
          visualData: 820/710/220/null//
  plugins: []
  references: []
`;

const [fixtureProject] = deserializeProject(fixture, projectPath);
const serializedFixture = serializeProject(fixtureProject) as string;
const [initialProject] = deserializeProject(serializedFixture, projectPath);

const project: WorkflowProjectItem = {
  id: 'graph-port-rename',
  name: projectName,
  fileName: `${projectName}.rivet-project`,
  relativePath: `${projectName}.rivet-project`,
  absolutePath: projectPath,
  updatedAt: '2026-09-14T00:00:00.000Z',
  settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
};

type ProjectSave = {
  contents: string;
  project: Project;
};

type ConnectionSummary = Pick<NodeConnection, 'inputId' | 'inputNodeId' | 'outputId' | 'outputNodeId' | 'bendPoint'>;

function getGraph(projectToInspect: Project, graphId: string): NodeGraph {
  const graph = projectToInspect.graphs[graphId as GraphId];
  expect(graph).toBeDefined();
  return graph!;
}

function getNode(projectToInspect: Project, graphId: string, nodeId: string): ChartNode {
  const node = getGraph(projectToInspect, graphId).nodes.find((candidate) => candidate.id === nodeId);
  expect(node).toBeDefined();
  return node!;
}

function getSubGraphData(projectToInspect: Project, graphId: string, nodeId: string) {
  const node = getNode(projectToInspect, graphId, nodeId);
  expect(node.type).toBe('subGraph');
  return node.data as {
    inputData?: Record<string, unknown>;
    inputPortOrder?: string[];
    outputPortOrder?: string[];
  };
}

function connectionSummaries(projectToInspect: Project, graphId: string): ConnectionSummary[] {
  return getGraph(projectToInspect, graphId).connections.map(({ bendPoint, inputId, inputNodeId, outputId, outputNodeId }) => ({
    ...(bendPoint ? { bendPoint } : {}),
    inputId,
    inputNodeId,
    outputId,
    outputNodeId,
  }));
}

function expectConnectionsIgnoringStorageOrder(
  projectToInspect: Project,
  graphId: string,
  predicate: (connection: ConnectionSummary) => boolean,
  expectedConnections: ConnectionSummary[],
) {
  const actualConnections = connectionSummaries(projectToInspect, graphId).filter(predicate);
  expect(actualConnections).toHaveLength(expectedConnections.length);
  expect(actualConnections).toEqual(expect.arrayContaining(expectedConnections));
}

function expectInputRenameState(projectToInspect: Project, expectedInputId: 'occupied-input' | 'final-input') {
  const expectedInputData = {
    'occupied-input': { type: 'string', value: 'occupied default' },
    'unrelated-input': { type: 'string', value: 'unrelated default' },
    ...(expectedInputId === 'final-input' ? { 'final-input': { type: 'string', value: 'old default' } } : {}),
  };
  const expectedRecursiveInputData = {
    'occupied-input': { type: 'string', value: 'recursive occupied default' },
    'unrelated-input': { type: 'string', value: 'recursive unrelated default' },
    ...(expectedInputId === 'final-input'
      ? { 'final-input': { type: 'string', value: 'recursive old default' } }
      : {}),
  };
  const expectedOrder =
    expectedInputId === 'final-input'
      ? ['unrelated-input', 'occupied-input', 'final-input']
      : ['unrelated-input', 'occupied-input'];

  for (const [graphId, nodeId, inputData] of [
    ['main', 'caller', expectedInputData],
    ['child', 'recursive', expectedRecursiveInputData],
  ] as const) {
    const data = getSubGraphData(projectToInspect, graphId, nodeId);
    expect(data.inputData).toEqual(inputData);
    expect(data.inputPortOrder).toEqual(expectedOrder);
  }

  expectConnectionsIgnoringStorageOrder(projectToInspect, 'main', (connection) => connection.inputNodeId === 'caller', [
    ...(expectedInputId === 'final-input'
      ? [
          {
            inputId: 'final-input',
            inputNodeId: 'caller',
            outputId: 'output',
            outputNodeId: 'source-old',
          },
        ]
      : []),
    {
      inputId: 'occupied-input',
      inputNodeId: 'caller',
      outputId: 'output',
      outputNodeId: 'source-occupied',
    },
    {
      inputId: 'unrelated-input',
      inputNodeId: 'caller',
      outputId: 'output',
      outputNodeId: 'source-unrelated',
    },
  ]);
  expectConnectionsIgnoringStorageOrder(projectToInspect, 'child', (connection) => connection.inputNodeId === 'recursive', [
    ...(expectedInputId === 'final-input'
      ? [
          {
            inputId: 'final-input',
            inputNodeId: 'recursive',
            outputId: 'output',
            outputNodeId: 'recursive-source-old',
          },
        ]
      : []),
    {
      inputId: 'occupied-input',
      inputNodeId: 'recursive',
      outputId: 'output',
      outputNodeId: 'recursive-source-occupied',
    },
    {
      inputId: 'unrelated-input',
      inputNodeId: 'recursive',
      outputId: 'output',
      outputNodeId: 'recursive-source-unrelated',
    },
  ]);
}

function expectOutputRenameState(projectToInspect: Project, expectedOutputId: 'occupied-output' | 'final-output') {
  const expectedOrder =
    expectedOutputId === 'final-output'
      ? ['unrelated-output', 'occupied-output', 'final-output']
      : ['unrelated-output', 'occupied-output'];
  for (const [graphId, nodeId] of [
    ['main', 'caller'],
    ['child', 'recursive'],
  ] as const) {
    expect(getSubGraphData(projectToInspect, graphId, nodeId).outputPortOrder).toEqual(expectedOrder);
  }

  const expectedMainOutputs: ConnectionSummary[] = [
    {
      bendPoint: { x: 41, y: 17 },
      inputId: 'input',
      inputNodeId: 'output-target-a',
      outputId: 'occupied-output',
      outputNodeId: 'caller',
    },
    ...(expectedOutputId === 'final-output'
      ? [
          {
            inputId: 'input',
            inputNodeId: 'output-target-a',
            outputId: 'final-output',
            outputNodeId: 'caller',
          },
        ]
      : []),
    {
      inputId: 'input',
      inputNodeId: 'output-target-b',
      outputId: expectedOutputId,
      outputNodeId: 'caller',
    },
    {
      inputId: 'input',
      inputNodeId: 'unrelated-target',
      outputId: 'unrelated-output',
      outputNodeId: 'caller',
    },
  ];
  const expectedRecursiveOutputs: ConnectionSummary[] = [
    {
      bendPoint: { x: 23, y: 29 },
      inputId: 'input',
      inputNodeId: 'recursive-target-a',
      outputId: 'occupied-output',
      outputNodeId: 'recursive',
    },
    ...(expectedOutputId === 'final-output'
      ? [
          {
            inputId: 'input',
            inputNodeId: 'recursive-target-a',
            outputId: 'final-output',
            outputNodeId: 'recursive',
          },
        ]
      : []),
    {
      inputId: 'input',
      inputNodeId: 'recursive-target-b',
      outputId: expectedOutputId,
      outputNodeId: 'recursive',
    },
    {
      inputId: 'input',
      inputNodeId: 'recursive-unrelated-target',
      outputId: 'unrelated-output',
      outputNodeId: 'recursive',
    },
  ];

  expectConnectionsIgnoringStorageOrder(
    projectToInspect,
    'main',
    (connection) => connection.outputNodeId === 'caller',
    expectedMainOutputs,
  );
  expectConnectionsIgnoringStorageOrder(
    projectToInspect,
    'child',
    (connection) => connection.outputNodeId === 'recursive',
    expectedRecursiveOutputs,
  );
}

async function installFixture(page: Page, saves: ProjectSave[]): Promise<void> {
  let savedContents = serializedFixture;
  let saveSequence = 0;
  await page.addInitScript(() => {
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false }));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/workflows/tree' && request.method() === 'GET') {
      const tree: WorkflowTreeResponse = {
        root: '/workflows',
        sync: { epoch: 'graph-port-rename-fixture', revision: 0 },
        folders: [],
        projects: [project],
      };
      await route.fulfill({ json: tree });
      return;
    }

    if (path === '/api/projects/load' && request.method() === 'POST') {
      await route.fulfill({ json: { contents: savedContents, datasetsContents: null, revisionId: `rename-${saveSequence}` } });
      return;
    }

    if (path === '/api/projects/save' && request.method() === 'POST') {
      const body = request.postDataJSON() as { contents?: unknown; path?: unknown; projectId?: unknown; saveIntent?: unknown };
      expect(body.contents).toEqual(expect.any(String));
      expect(body.path).toBe(projectPath);
      expect(body.projectId).toBe(project.id);
      expect(body.saveIntent).toBe('in-place');
      savedContents = body.contents as string;
      const [savedProject] = deserializeProject(savedContents, projectPath);
      saves.push({ contents: savedContents, project: savedProject });
      saveSequence += 1;
      await route.fulfill({ json: { path: projectPath, revisionId: `rename-${saveSequence}` } });
      return;
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      await route.abort('blockedbyclient');
      return;
    }

    await route.fallback();
  });
}

async function openFixture(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  const projectRow = page.locator('.project-row', { hasText: projectName });
  await expect(projectRow).toBeEnabled({ timeout: 90_000 });
  await projectRow.dblclick();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await expect(frame.locator('.node[data-nodeid="caller"]')).toBeVisible({ timeout: 90_000 });
  return frame;
}

async function editNodeId(page: Page, node: Locator, nextId: string) {
  await editNodeIds(page, node, [nextId]);
}

async function editNodeIds(page: Page, node: Locator, nextIds: readonly string[]) {
  await node.hover();
  await node.locator('.edit-button').click();
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  const idField = frame.locator('input[name="id"]');
  await expect(idField).toBeVisible();
  for (const nextId of nextIds) {
    await idField.fill(nextId);
    await idField.press('Enter');
    await expect(node).toContainText(nextId);
    await expect(idField).toBeVisible();
  }
  await idField.press('Escape');
  await expect(idField).toBeHidden();
}

async function closeOpenNodeEditor(page: Page): Promise<void> {
  const idField = page.frameLocator('iframe.dashboard-editor-frame').locator('input[name="id"]');
  if (await idField.isVisible()) {
    await idField.press('Escape');
    await expect(idField).toBeHidden();
  }
}

async function openChildGraph(page: Page) {
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await closeOpenNodeEditor(page);
  const caller = frame.locator('.node[data-nodeid="caller"]');
  await caller.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
  await expect(frame.locator('.node[data-nodeid="child-input"]')).toBeVisible();
  return frame;
}

async function returnToParentGraph(page: Page) {
  const frame = page.frameLocator('iframe.dashboard-editor-frame');
  await closeOpenNodeEditor(page);
  await frame.getByRole('button', { name: 'Go to previous graph', exact: true }).click();
  await expect(frame.locator('.node[data-nodeid="caller"]')).toBeVisible();
  return frame;
}

async function saveProject(page: Page, saves: readonly ProjectSave[]): Promise<Project> {
  const saveButton = page.locator('.active-project-save-button');
  await expect(saveButton).toBeVisible();
  const saveCount = saves.length;
  await saveButton.click();
  await expect.poll(() => saves.length).toBe(saveCount + 1);
  return saves.at(-1)!.project;
}

test('graph port collision handling persists caller values, fan-out, and recursive callers', async ({ page }) => {
  const saves: ProjectSave[] = [];
  await installFixture(page, saves);
  let frame = await openFixture(page);
  const caller = frame.locator('.node[data-nodeid="caller"]');

  await test.step('An input collision preserves the existing caller value and recursive caller', async () => {
    frame = await openChildGraph(page);
    await editNodeId(page, frame.locator('.node[data-nodeid="child-input"]'), 'occupied-input');
    frame = await returnToParentGraph(page);
    await expect(caller).toContainText('occupied-input');
    await expect(caller).not.toContainText('old-input');

    expectInputRenameState(await saveProject(page, saves), 'occupied-input');
  });

  await test.step('An output collision preserves bend metadata and fan-out in both callers', async () => {
    frame = await openChildGraph(page);
    await editNodeId(page, frame.locator('.node[data-nodeid="child-output"]'), 'occupied-output');
    frame = await returnToParentGraph(page);
    await expect(caller).toContainText('occupied-output');
    await expect(caller).not.toContainText('old-output');

    const collisionProject = await saveProject(page, saves);
    expectInputRenameState(collisionProject, 'occupied-input');
    expectOutputRenameState(collisionProject, 'occupied-output');
  });
});

test('merged graph port edits rebuild persisted caller state and real Undo/Redo', async ({ page }) => {
  const saves: ProjectSave[] = [];
  let expectedFinalGraphs: Project['graphs'] | undefined;
  await installFixture(page, saves);
  let frame = await openFixture(page);
  const caller = frame.locator('.node[data-nodeid="caller"]');

  await test.step('Rapid input and output edits rebuild from the original caller snapshots', async () => {
    frame = await openChildGraph(page);
    await editNodeIds(page, frame.locator('.node[data-nodeid="child-input"]'), ['occupied-input', 'final-input']);
    await editNodeIds(page, frame.locator('.node[data-nodeid="child-output"]'), ['occupied-output', 'final-output']);
    const activeChildProject = await saveProject(page, saves);
    expectInputRenameState(activeChildProject, 'final-input');
    expectOutputRenameState(activeChildProject, 'final-output');
    frame = await returnToParentGraph(page);
    await expect(caller).toContainText('final-input');
    await expect(caller).toContainText('final-output');
    await expect(caller).not.toContainText('old-input');
    await expect(caller).not.toContainText('old-output');

    expectedFinalGraphs = activeChildProject.graphs;
  });

  await test.step('Undo and Redo restore exact persisted graph snapshots', async () => {
    frame = await openChildGraph(page);
    await frame.locator('.node[data-nodeid="child-output"]').press(`${shortcutModifier}+Z`);
    await frame.locator('.node[data-nodeid="child-input"]').press(`${shortcutModifier}+Z`);
    frame = await returnToParentGraph(page);
    await expect(caller).toContainText('old-input');
    await expect(caller).toContainText('old-output');

    const undoneProject = await saveProject(page, saves);
    expect(undoneProject.graphs).toEqual(initialProject.graphs);

    frame = await openChildGraph(page);
    await frame.locator('.node[data-nodeid="child-input"]').press(`${shortcutModifier}+Shift+Z`);
    await frame.locator('.node[data-nodeid="child-output"]').press(`${shortcutModifier}+Shift+Z`);
    frame = await returnToParentGraph(page);
    await expect(caller).toContainText('final-input');
    await expect(caller).toContainText('final-output');

    const redoneProject = await saveProject(page, saves);
    expect(expectedFinalGraphs).toBeDefined();
    expect(redoneProject.graphs).toEqual(expectedFinalGraphs);
  });
});
