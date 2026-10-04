import { expect, test } from '@playwright/test';
import { deserializeProject, ExecutionRecorder, getGraphBoundary, serializeProject } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowProjectItem } from '../dashboard/types';

type RecordingUpload = {
  projectId: string;
  status: string;
  recordingSerialized: string;
  correlationId?: string;
  executionIdentity?: { correlationId: string };
};

function projectContents(id: string): string {
  return `version: 4
data:
  metadata:
    id: ${id}
    title: ${id}
    description: ""
    mainGraphId: main
  graphs:
    main:
      metadata:
        id: main
        name: Main Graph
      nodes:
        '[value]:text "Value"':
          data:
            text: recording-result
          visualData: 200/220/240/null//
          outgoingConnections:
            - output->"Result" result/value
        '[result]:graphOutput "Result"':
          data:
            id: result
            dataType: string
          visualData: 600/220/240/null//
  plugins: []
  references: []
`;
}

for (const executor of ['browser', 'nodejs'] as const) {
  for (const scenario of [
    'enabled',
    'disabled',
    'successful-abort',
    'upload-failure',
    'caught-subgraph-error',
    'failed-root',
    'child-failure',
    'child-failed-abort',
  ] as const) {
    if (executor === 'nodejs' && scenario.startsWith('child-')) continue;
    const recordExecutions = scenario !== 'disabled';
    const failedChild = scenario === 'child-failure' || scenario === 'child-failed-abort';
    const crossProject =
      executor === 'browser' && (['enabled', 'disabled', 'upload-failure'].includes(scenario) || failedChild);
    test(`${executor} parent recording ${scenario}`, async ({ page }) => {
      test.slow();
      const parentId = 'local-recording-parent';
      const childId = 'local-recording-child';
      const parentPath = `/workflows/${parentId}.rivet-project`;
      const [parent] = deserializeProject(projectContents(parentId), parentPath);
      let childContents = projectContents(childId);
      const [child] = deserializeProject(childContents, `/workflows/${childId}.rivet-project`);
      // The Browser path exercises the reported cross-project reproduction.
      // The real Node transport runs a plain graph so it needs no test project
      // written into the working server's project roots.
      if (crossProject) {
        const value = parent.graphs.main!.nodes[0]!;
        value.type = 'subGraph';
        value.data = {
          graphId: 'main',
          targetProjectId: childId,
          targetVersion: 'latest',
          targetBoundary: getGraphBoundary(child, 'main' as never),
        };
        parent.graphs.main!.connections[0]!.outputId = 'result' as never;
      }
      if (failedChild) {
        const failingNode = child.graphs.main!.nodes[0]!;
        failingNode.type = scenario === 'child-failure' ? 'code' : 'abortGraph';
        failingNode.data =
          scenario === 'child-failure'
            ? { code: 'throw new Error("Called project failure");', inputNames: [], outputNames: [] }
            : { successfully: false, errorMessage: 'Called project abort' };
        child.graphs.main!.nodes = [failingNode];
        child.graphs.main!.connections = [];
        childContents = serializeProject(child) as string;
        Object.assign(parent.graphs.main!.nodes[0]!.data, {
          useErrorOutput: true,
          targetBoundary: getGraphBoundary(child, 'main' as never),
        });
        parent.graphs.main!.connections[0]!.outputId = 'error' as never;
      }
      if (scenario === 'successful-abort') {
        const abort = parent.graphs.main!.nodes[1]!;
        abort.type = 'abortGraph';
        abort.data = { successfully: true };
        parent.graphs.main!.connections[0]!.inputId = 'data' as never;
      }
      if (scenario === 'caught-subgraph-error') {
        const failingGraph = child.graphs.main!;
        failingGraph.metadata!.id = 'handled-child' as never;
        const failingNode = failingGraph.nodes[0]!;
        failingNode.type = 'code';
        failingNode.data = { code: 'throw new Error("Handled child failure");', inputNames: [], outputNames: [] };
        failingGraph.nodes = [failingNode];
        failingGraph.connections = [];
        parent.graphs['handled-child'] = failingGraph;
        const call = parent.graphs.main!.nodes[0]!;
        call.type = 'subGraph';
        call.data = { graphId: 'handled-child', useErrorOutput: true };
        parent.graphs.main!.connections[0]!.outputId = 'error' as never;
      }
      if (scenario === 'failed-root') {
        const failingNode = parent.graphs.main!.nodes[0]!;
        failingNode.type = 'code';
        failingNode.data = { code: 'throw new Error("Unhandled root failure");', inputNames: [], outputNames: [] };
        parent.graphs.main!.connections = [];
      }
      const contents = serializeProject(parent) as string;
      const project: WorkflowProjectItem = {
        id: parentId,
        projectMetadataId: parentId,
        name: parentId,
        fileName: `${parentId}.rivet-project`,
        relativePath: `${parentId}.rivet-project`,
        absolutePath: parentPath,
        updatedAt: '2026-10-03T00:00:00.000Z',
        settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
      };
      const uploads: Array<{ path: string; body: RecordingUpload }> = [];
      const unavailableCorrelations: string[] = [];
      const unexpectedMutations: string[] = [];
      await page.addInitScript(
        ({ executor, recordExecutions }) => {
          localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: executor, recordExecutions }));
        },
        { executor, recordExecutions },
      );
      await mockHostedEditorBootstrap(page);
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path === '/api/workflows/tree') {
          await route.fulfill({
            json: {
              root: '/workflows',
              sync: { epoch: 'local-recordings-fixture', revision: 0 },
              projects: [project],
              folders: [],
            },
          });
        } else if (path === '/api/projects/load') {
          await route.fulfill({ json: { contents, datasetsContents: null, revisionId: null } });
        } else if (path === '/api/workflows/local-editor-recordings/capability') {
          await route.fulfill({ json: { supported: true } });
        } else if (path === `/api/workflows/subgraph-projects/${childId}/execution`) {
          await route.fulfill({ json: { projectContents: childContents, revisionKey: 'fixture-child' } });
        } else if (path === `/api/workflows/subgraph-projects/${childId}/preview`) {
          await route.fulfill({ json: { project: child } });
        } else if (
          request.method() === 'POST' &&
          ['/api/workflows/local-editor-recordings', '/api/workflows/local-editor-recordings/subgraph-run'].includes(
            path,
          )
        ) {
          uploads.push({ path, body: request.postDataJSON() });
          if (scenario === 'upload-failure' && path === '/api/workflows/local-editor-recordings') {
            await route.fulfill({ status: 500, json: { error: 'Fixture recording storage unavailable' } });
            return;
          }
          await route.fulfill({
            status: 201,
            json: { availability: 'available', recordingId: `fixture-${uploads.length}` },
          });
        } else if (path === '/api/workflows/local-editor-recordings/outcome' && request.method() === 'POST') {
          unavailableCorrelations.push(request.postDataJSON().correlationId);
          await route.fulfill({ status: 204 });
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
      await page.locator('.project-row', { hasText: parentId }).dblclick();
      const frame = page.frameLocator('iframe.dashboard-editor-frame');
      const result = frame.locator('.node[data-nodeid="result"]');
      await expect(result).toBeVisible({ timeout: 90_000 });
      await frame.locator('.run-button button').first().click();
      if (!['successful-abort', 'failed-root'].includes(scenario)) await expect(result).toHaveClass(/success/);
      if (recordExecutions) {
        await expect.poll(() => uploads.length).toBe(crossProject ? 2 : 1);
        const root = uploads.find((upload) => upload.path === '/api/workflows/local-editor-recordings')!.body;
        expect(root.projectId).toBe(parentId);
        expect(root.status).toBe(scenario === 'failed-root' ? 'failed' : 'succeeded');
        const recorder = ExecutionRecorder.deserializeFromString(root.recordingSerialized);
        expect(recorder.events.some((event) => event.type === 'start')).toBe(true);
        expect(recorder.events.some((event) => event.type === (scenario === 'failed-root' ? 'error' : 'done'))).toBe(
          true,
        );
        if (crossProject) {
          const nested = uploads.find((upload) => upload.path.endsWith('/subgraph-run'))!.body;
          expect(nested.projectId).toBe(childId);
          expect(root.executionIdentity?.correlationId).toMatch(/^rvt-local-/);
          expect(nested.correlationId).toBe(root.executionIdentity?.correlationId);
          expect(nested.status).toBe(failedChild ? 'failed' : 'succeeded');
          if (failedChild) {
            const nestedRecorder = ExecutionRecorder.deserializeFromString(nested.recordingSerialized);
            expect(nestedRecorder.events.some((event) => event.type === 'error')).toBe(true);
            expect(nestedRecorder.events.some((event) => event.type === 'done')).toBe(false);
          }
        }
        if (scenario === 'successful-abort') {
          expect(recorder.events.some((event) => event.type === 'abort' && event.data.successful)).toBe(true);
        }
        if (scenario === 'caught-subgraph-error') {
          expect(
            recorder.events.some((event) => event.type === 'graphError' && event.data.graphId === 'handled-child'),
          ).toBe(true);
        }
        if (scenario === 'upload-failure') {
          await expect.poll(() => unavailableCorrelations).toEqual([root.executionIdentity?.correlationId]);
          await expect(result).toHaveClass(/success/);
          expect(uploads.filter((upload) => upload.path === '/api/workflows/local-editor-recordings')).toHaveLength(1);
        } else {
          expect(unavailableCorrelations).toEqual([]);
        }
      } else {
        // Give post-terminal finalization time to run before asserting absence.
        await page.waitForTimeout(1_000);
        expect(uploads).toEqual([]);
      }
      expect(unexpectedMutations).toEqual([]);
    });
  }
}
