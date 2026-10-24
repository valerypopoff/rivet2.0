import { expect, test } from '@playwright/test';
import type { EvaluationRecordingArtifact, EvaluationRun } from '@valerypopoff/rivet2-evaluations';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

for (const storageFails of [false, true]) {
  test(`Browser evaluation uses shared trial orchestration (recording storage ${storageFails ? 'fails' : 'works'})`, async ({
    page,
  }) => {
    await mockHostedEditorBootstrap(page);
    await seedHostedEditorProject(page, {
      graphId: 'main',
      loaded: true,
      projectId: 'trial-project',
      projectPath: '/workflows/Trial.rivet-project',
      title: 'Trial',
      graph: {
        nodes: [
          {
            id: 'value',
            type: 'text',
            title: 'Value',
            data: { text: 'trial-result' },
            visualData: { x: 0, y: 0, width: 240 },
          },
          {
            id: 'output',
            type: 'graphOutput',
            title: 'Output',
            data: { id: 'result', dataType: 'string' },
            visualData: { x: 400, y: 0, width: 240 },
          },
        ],
        connections: [{ outputNodeId: 'value', outputId: 'output', inputNodeId: 'output', inputId: 'value' }],
      },
    });
    await page.addInitScript(() =>
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: false })),
    );
    const suite = {
      id: 'suite',
      name: 'Trial suite',
      targetGraphId: 'main',
      datasetId: 'dataset',
      inputBindings: [],
      assertions: [],
      evaluators: [],
    };
    const runs = new Map<string, EvaluationRun>();
    const artifacts: EvaluationRecordingArtifact[] = [];
    await page.route('**/api/workflows/evaluation-runs/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.split('/evaluation-runs/')[1]!;
      if (path === 'library/events') return route.fulfill({ status: 204 });
      if (path === 'library')
        return route.fulfill({
          json: {
            revision: 1,
            resourceVersions: { suites: { suite: 1 }, datasets: { dataset: 1 } },
            library: {
              version: 1,
              data: { version: 1, suites: [suite], baselines: [] },
              datasets: [
                { id: 'dataset', name: 'Trial dataset', fields: [], cases: [{ id: 'case', name: 'Case', values: {} }] },
              ],
              migratedLegacyProjectIds: ['trial-project'],
            },
          },
        });
      if (path === 'history') return route.fulfill({ json: { runs: [...runs.values()] } });
      if (path.startsWith('datasets/')) return route.fulfill({ json: {} });
      if (path.startsWith('events/')) return route.fulfill({ json: {} });
      if (path.startsWith('recordings/')) {
        if (request.method() === 'PUT') {
          artifacts.push(request.postDataJSON());
          return route.fulfill({ status: storageFails ? 503 : 200, json: {} });
        }
        if (request.method() === 'PATCH') return route.fulfill({ json: { updated: true } });
        return route.fulfill({ json: artifacts[0] });
      }
      if (request.method() === 'PUT') {
        const { run } = request.postDataJSON() as { run: EvaluationRun };
        runs.set(run.id, run);
        return route.fulfill({ json: {} });
      }
      const run = runs.get(path);
      if (request.method() === 'GET') return route.fulfill({ status: run ? 200 : 404, json: run ?? {} });
      throw new Error(`Unexpected trial fixture request: ${request.method()} ${path}`);
    });
    await page.goto('/?editor');
    await page
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('button', { name: 'Evaluations' })
      .click();
    await page
      .getByRole('button', { name: /^Trial suite(?: Main Graph)?$/ })
      .last()
      .click();
    await page.getByRole('button', { name: 'Run execution benchmark', exact: true }).click();
    await expect.poll(() => [...runs.values()].find((run) => run.executionStatus === 'completed')).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Run execution benchmark', exact: true })).toBeEnabled();
    const run = [...runs.values()][0]!;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ projectId: 'trial-project', runId: run.id, trialId: 'case:0' });
    expect(artifacts[0]!.serialized).toContain('trial-result');
    expect(run.trials).toHaveLength(1);
    expect(run.trials[0]).toMatchObject({ executionStatus: 'completed', outputs: { result: 'trial-result' } });
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    const trial = page.locator('.evaluation-trial');
    await expect(trial).toHaveCount(1);
    await trial.locator('button.collapsible-panel-toggle').click();
    await expect(trial).toContainText('trial-result');
    if (storageFails) {
      expect(run.warnings.join(' ')).toMatch(/recording.*not.*retain/i);
      expect(run.trials[0]!.recording).toBeUndefined();
    } else {
      expect(run.trials[0]!.recording?.id).toBe(artifacts[0]!.reference.id);
    }
  });
}
