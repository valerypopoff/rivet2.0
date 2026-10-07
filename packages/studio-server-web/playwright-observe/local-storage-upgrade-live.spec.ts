import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import { serializeDatasets, deserializeProject, serializeProject } from '@valerypopoff/rivet2-core';
import {
  controlLocalUpgradeRehearsal,
  loadLocalUpgradeRehearsal,
  recordLocalUpgradeRehearsalPhase,
} from '../../../deploy/studio-server/scripts/local-upgrade-image-rehearsal.mjs';

const manifest = process.env.RIVET_LOCAL_UPGRADE_REHEARSAL_MANIFEST;
test.use({ actionTimeout: 30_000 });
test.skip(
  !manifest,
  'Run only through the disposable production-image rehearsal; never against an ordinary VM/dev stack.',
);

test('production images support real UI conversion, online/offline rollback and writable SQLite after restart', async ({
  page,
  request,
}) => {
  test.setTimeout(720_000);
  const evidence = (phase: string) => recordLocalUpgradeRehearsalPhase(manifest!, phase);
  const control = (action: Parameters<typeof controlLocalUpgradeRehearsal>[1]) =>
    controlLocalUpgradeRehearsal(manifest!, action);
  const open = async () => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    const prompt = page.getByTestId('local-storage-upgrade-prompt');
    const setupResponse = await page.request.get('/api/app-settings/local-upgrade/setup');
    expect(setupResponse.ok()).toBe(true);
    const setup = (await setupResponse.json()) as { eligible: boolean; liveSqlite: boolean };
    if (setup.eligible && !setup.liveSqlite) await expect(prompt).toBeVisible();
    if (await prompt.isVisible()) {
      await prompt.getByRole('button', { name: /Review upgrade steps|Continue upgrade or recovery/u }).click();
    } else {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
    await page
      .getByTestId('app-settings-modal')
      .getByRole('tab', { name: 'Local storage upgrade', exact: true })
      .click();
    return page.getByRole('tabpanel', { name: 'Local storage upgrade', exact: true });
  };
  const copy = async () => {
    const panel = await open();
    await panel.getByRole('button', { name: 'Pause writes and create verified backup', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Download verified backup', exact: true })).toBeEnabled({
      timeout: 90_000,
    });
    const unauthorized = await request.get('/api/app-settings/local-upgrade');
    if (unauthorized.status() === 200) expect(await unauthorized.text()).toContain('Enter Access Key');
    else expect(unauthorized.status()).toBeGreaterThanOrEqual(400);
    // Download through the actual authenticated attachment route, and verify
    // its bytes against the server's durable archive evidence. Downloads stay
    // in Playwright's temporary storage, never in uploaded trace artifacts.
    const download = async (name: string) => {
      const pending = page.waitForEvent('download');
      await panel.getByRole('button', { name, exact: true }).click();
      const file = await pending;
      expect(await file.failure()).toBeNull();
      const stream = await file.createReadStream();
      expect(stream).not.toBeNull();
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of stream!) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      return { hash: hash.digest('hex'), bytes };
    };
    const archive = await download('Download verified backup');
    await expect(panel.getByRole('button', { name: 'Download encryption key separately' })).toHaveCount(0);
    const status = await (await page.request.get('/api/app-settings/local-upgrade')).json();
    expect(archive.hash).toBe(status.backup.archiveHash);
    expect(archive.bytes).toBe(status.backup.bytes);
    expect(status.settingsEncryptionRequired).toBe(false);
    const frozen = await control('restore-backup');
    expect(status.backup.sourceFingerprint).toBe(frozen);
    await panel.getByLabel('I saved the verified backup download securely outside this VM.').check();
    await expect(panel.getByLabel('I backed up the local settings encryption key separately.')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Copy and verify', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Activate SQLite while paused' })).toBeEnabled({ timeout: 90_000 });
    await panel.getByRole('button', { name: 'Activate SQLite while paused' }).click();
    await expect(panel.getByText('SQLite runtime validation passed.', { exact: false })).toBeVisible({
      timeout: 120_000,
    });
    return open();
  };
  const validate = async () => {
    const panel = await open();
    await expect(panel.getByText('runtime validation passed.', { exact: false })).toBeVisible({ timeout: 120_000 });
    const acknowledgement = panel.getByLabel(
      'I reviewed the selected backend and its write-resumption recovery boundary.',
    );
    await expect(acknowledgement).toBeEnabled();
    await acknowledgement.check();
    await expect(panel.getByRole('button', { name: 'Resume writes', exact: true })).toBeEnabled();
    return panel;
  };
  const resume = async (backend: 'legacy' | 'sqlite') => {
    const panel = await validate();
    await panel.getByRole('button', { name: 'Resume writes', exact: true }).click();
    await expect
      .poll(
        async () => {
          try {
            const response = await page.request.get('/api/app-settings/local-upgrade');
            if (!response.ok()) return false;
            const status = await response.json();
            return (
              status.available &&
              status.runtimeReady &&
              !status.restartRequired &&
              !status.operation &&
              !status.maintenance &&
              status.runningBackend === backend &&
              status.transition?.backend === backend &&
              status.transition?.paused === false &&
              status.transition?.phase === (backend === 'sqlite' ? 'sqlite-live' : 'legacy-resumed')
            );
          } catch {
            return false;
          }
        },
        { timeout: 120_000 },
      )
      .toBe(true);
  };

  // Real UI -> API online rollback while both processes remain paused.
  const panel = await copy();
  await panel.getByRole('button', { name: 'Return to legacy while paused' }).click();
  await expect(panel.getByText('Legacy runtime validation passed.', { exact: false })).toBeVisible({
    timeout: 120_000,
  });
  await resume('legacy');
  await evidence('online-recovery');

  // Corrupt selected settings: packaged startup must fail and packaged CLI
  // must recover without opening the candidate or needing its settings key.
  await copy();
  await control('corrupt-candidate');
  await control('offline-return');
  await resume('legacy');
  await evidence('offline-recovery');

  // Final conversion serves only the SQLite authority, including after writes.
  await copy();
  await resume('sqlite');
  const completed = await (await page.request.get('/api/app-settings/local-upgrade')).json();
  expect(completed.runningBackend).toBe('sqlite');
  expect(completed.transition.canReturnToLegacy).toBe(false);
  const rollback = await page.request.post('/api/app-settings/local-upgrade/action', {
    data: { action: 'return-to-legacy', revision: completed.transition.revision },
  });
  expect(rollback.ok()).toBe(false);
  const afterRollback = await (await page.request.get('/api/app-settings/local-upgrade')).json();
  expect(afterRollback.transition).toEqual(completed.transition);
  expect(afterRollback.runningBackend).toBe('sqlite');
  expect(afterRollback.maintenance).toBeNull();
  // Completion retires the wizard rather than leaving a read-only settings tab.
  await page.goto('/');
  await waitForDashboardReady(page);
  const setupResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/app-settings/local-upgrade/setup',
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect((await (await setupResponse).json()).liveSqlite).toBe(true);
  await expect(page.getByTestId('app-settings-modal')).toBeVisible();
  await expect(
    page.getByTestId('app-settings-modal').getByRole('tab', { name: 'Local storage upgrade', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('local-storage-upgrade-prompt')).toHaveCount(0);
  await evidence('conversion');
  // Exercise the actual embedded-editor save bridge before using its API to
  // make deterministic content changes. No mock or direct catalog write.
  await page.goto('/');
  await waitForDashboardReady(page);
  await page.getByRole('button', { name: 'rehearsal', exact: true }).dblclick();
  const canvas = page.frameLocator('iframe').locator('.node-canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const editorSave = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/projects/save',
  );
  await canvas.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  expect((await editorSave).ok()).toBe(true);

  const api = async (route: string, data?: unknown, method = 'POST') => {
    const response =
      data === undefined ? await page.request.get(route) : await page.request.fetch(route, { method, data });
    expect(response.ok(), `${route}: ${response.status()} ${await response.text()}`).toBe(true);
    if (response.status() === 204) return;
    return response.json();
  };
  let relativePath = 'rehearsal.rivet-project';
  const load = () => api('/api/projects/load', { path: `/workflows/${relativePath}` });
  const snapshot = () => api(`/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(relativePath)}`);
  const preconditions = async () => {
    const state = await snapshot();
    return {
      expectedProjectId: state.projectId,
      expectedDraftRevisionId: state.draftRevisionId,
      expectedPublicationVersion: state.publicationVersion,
    };
  };
  const execute = async (latest = false) => {
    const response = await page.request.post(`${latest ? '/workflows-latest' : '/workflows'}/local-upgrade-rehearsal`, {
      headers: { Authorization: `Bearer ${process.env.RIVET_KEY}`, 'Content-Type': 'application/json' },
      data: JSON.stringify('sqlite-new-recording-input'),
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).value.value;
  };
  const original = await load();
  const datasetsContents = serializeDatasets([
    {
      meta: {
        id: 'rehearsal-dataset' as never,
        projectId: '230bbbc2-f5ec-41ea-99d2-bcbb43e82f3b' as never,
        name: 'SQLite dataset',
        description: '',
      },
      data: { id: 'rehearsal-dataset' as never, rows: [{ id: 'rehearsal-row', data: ['sqlite-dataset-value'] }] },
    },
  ]);
  expect(original.contents).toContain('hostname: process.env.HOSTNAME,');
  const changedContents = original.contents.replace(
    'hostname: process.env.HOSTNAME,',
    "hostname: process.env.HOSTNAME, draftMarker: 'sqlite-draft', packageValue: require('example'),",
  );
  const save = {
    path: `/workflows/${relativePath}`,
    contents: changedContents,
    datasetsContents,
    expectedRevisionId: original.revisionId,
    saveIntent: 'in-place',
  };
  await api('/api/projects/save', save);
  const changed = await load();
  expect(changed.revisionId).not.toBe(original.revisionId);
  expect(changed.datasetsContents).toBe(datasetsContents);
  const stale = await page.request.post('/api/projects/save', { data: save });
  expect(stale.status()).toBe(409);
  expect((await load()).revisionId).toBe(changed.revisionId);
  await evidence('project-save-and-conflict');
  expect((await execute(true)).draftMarker).toBe('sqlite-draft');
  expect((await execute()).draftMarker).toBeUndefined();
  await api('/api/workflows/folders', { name: 'sqlite-only-folder', parentRelativePath: '' });
  const projectId = (await snapshot()).projectId;
  await api('/api/workflows/projects', { relativePath, newName: 'Renamed rehearsal' }, 'PATCH');
  relativePath = 'Renamed rehearsal.rivet-project';
  await api('/api/workflows/move', {
    itemType: 'project',
    sourceRelativePath: relativePath,
    destinationFolderRelativePath: 'sqlite-only-folder',
  });
  relativePath = `sqlite-only-folder/${relativePath}`;
  expect((await snapshot()).projectId).toBe(projectId);
  expect((await execute()).draftMarker).toBeUndefined();
  const history = await api(
    `/api/workflows/projects/published-versions?relativePath=${encodeURIComponent(relativePath)}`,
  );
  const previousVersion = history.versions.find((version: { isCurrent: boolean }) => version.isCurrent);
  expect(previousVersion).toBeTruthy();
  await api('/api/workflows/projects/publish', {
    relativePath,
    settings: { endpointName: 'local-upgrade-rehearsal' },
    preconditions: await preconditions(),
  });
  expect((await execute()).draftMarker).toBe('sqlite-draft');
  await api(
    '/api/workflows/projects/published-versions/star',
    { relativePath, versionId: previousVersion.id, isStarred: true },
    'PATCH',
  );
  await api(
    '/api/workflows/projects/published-versions/comment',
    { relativePath, versionId: previousVersion.id, comment: 'retained-through-sqlite' },
    'PATCH',
  );
  const historyAfter = await api(
    `/api/workflows/projects/published-versions?relativePath=${encodeURIComponent(relativePath)}`,
  );
  expect(historyAfter.versions.find((version: { id: string }) => version.id === previousVersion.id)).toMatchObject({
    isStarred: true,
    comment: 'retained-through-sqlite',
  });
  await api('/api/workflows/projects/published-versions/restore', {
    relativePath,
    versionId: previousVersion.id,
    preconditions: await preconditions(),
  });
  expect((await execute()).draftMarker).toBeUndefined();
  await evidence('publication-and-history');

  const variablesBefore = await page.request.get('/api/app-settings/environment-variables');
  await api(
    '/api/app-settings/environment-variables',
    {
      variables: [
        {
          id: 'rehearsal-private-variable',
          name: 'RIVET_RELEASE_GATE_VALUE',
          value: 'sqlite-private-setting',
          browserAccess: false,
        },
      ],
    },
    'PUT',
  );
  const settingsConflict = await page.request.put('/api/app-settings/environment-variables', {
    headers: { 'If-Match': variablesBefore.headers().etag },
    data: { variables: [] },
  });
  expect(settingsConflict.status()).toBe(409);
  expect((await execute()).environmentValue).toBe('sqlite-private-setting');
  expect(await (await page.request.get('/api/app-settings/environment-variables')).text()).not.toContain(
    'sqlite-private-setting',
  );

  // Restore changes only the draft. Install through the real npm-backed job,
  // republish that controlled draft, and prove a failed job keeps it usable.
  const restored = await load();
  await api('/api/projects/save', {
    ...save,
    path: `/workflows/${relativePath}`,
    expectedRevisionId: restored.revisionId,
  });
  await api('/api/workflows/projects/publish', {
    relativePath,
    settings: { endpointName: 'local-upgrade-rehearsal' },
    preconditions: await preconditions(),
  });
  const install = async (version: string, expected: string) => {
    const job = await api('/api/runtime-libraries/install', { packages: [{ name: 'example', version }] });
    await expect
      .poll(async () => (await api(`/api/runtime-libraries/jobs/${job.id}`)).status, { timeout: 90_000 })
      .toBe(expected);
  };
  await install('2.0.0', 'succeeded');
  expect((await execute()).packageValue).toBe(84);
  await install('9.9.9', 'failed');
  expect((await execute()).packageValue).toBe(84);
  await evidence('settings-and-libraries');

  // Real editor -> supervised executor, not a mocked graph run or endpoint-only
  // package check. This graph has no external inputs or integrations.
  const [editorProject] = deserializeProject(changedContents, '/workflows/editor-library.rivet-project');
  editorProject.metadata.id = 'sqlite-editor-library-project' as never;
  editorProject.metadata.title = 'Editor library';
  const graph = editorProject.graphs[editorProject.metadata.mainGraphId!];
  graph.nodes = graph.nodes.filter((node) => node.id !== 'input-node');
  graph.connections = graph.connections.filter((connection) => connection.outputNodeId !== 'input-node');
  const code = graph.nodes.find((node) => node.id === 'environment-node')!;
  code.data = {
    ...code.data,
    inputNames: [],
    code: "return { output: { type: 'any', value: { packageValue: require('example') } } };",
  } as never;
  await api('/api/workflows/projects/upload', {
    folderRelativePath: '',
    fileName: 'editor-library.rivet-project',
    contents: serializeProject(editorProject),
  });
  const runEditorPackage = async (expected: number) => {
    await page.goto('/');
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'editor-library', exact: true }).dblclick();
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const node = frame.locator('.node[data-nodeid="environment-node"]');
    await expect(node).toBeVisible({ timeout: 90_000 });
    await frame.locator('.more-menu').click();
    const nodeExecutor = frame
      .getByRole('group', { name: 'Executor mode' })
      .getByRole('button', { name: 'Node', exact: true });
    await nodeExecutor.click();
    await expect(nodeExecutor).toHaveAttribute('aria-pressed', 'true');
    await frame.locator('.more-menu').click();
    await frame.locator('.run-button button').first().click();
    await expect(node).toHaveClass(/success/, { timeout: 30_000 });
    await expect(node.locator('.node-output')).toContainText(String(expected));
  };
  await runEditorPackage(84);
  const removed = await api('/api/runtime-libraries/remove', { packages: ['example'] });
  await expect
    .poll(async () => (await api(`/api/runtime-libraries/jobs/${removed.id}`)).status, { timeout: 90_000 })
    .toBe('succeeded');
  expect((await api('/api/runtime-libraries')).packages.example).toBeUndefined();
  const missing = await page.request.post('/workflows/local-upgrade-rehearsal', {
    headers: { Authorization: `Bearer ${process.env.RIVET_KEY}`, 'Content-Type': 'application/json' },
    data: JSON.stringify('missing-package'),
  });
  expect(missing.ok()).toBe(false);
  await install('1.0.0', 'succeeded');
  expect((await execute()).packageValue).toBe(42);
  await runEditorPackage(42);
  await install('2.0.0', 'succeeded');
  await runEditorPackage(84);
  await evidence('editor-libraries-and-removal');

  const readBinding = async () => JSON.parse((await control('read-web-app-binding'))!);
  const binding = await readBinding();
  expect(binding.appId).toBeTruthy();
  await api('/api/workflows/projects/web-apps/publish', {
    relativePath,
    publications: [
      { uiGraphId: 'release-gate-web-app', slug: 'sqlite-policy-app', allowedEmails: ['allowed@example.test'] },
    ],
    preconditions: await preconditions(),
  });
  expect((await readBinding()).appId).toBe(binding.appId);
  await api(
    '/api/app-settings/web-app-auth',
    {
      mode: 'oauth',
      provider: 'dummy',
      dummyEmail: 'allowed@example.test',
      sessionSecret: 'isolated-fixture-session-secret',
      dummyAllowNonLocalhost: true,
    },
    'PUT',
  );
  const allowedContext = await page.context().browser()!.newContext();
  const allowedPage = await allowedContext.newPage();
  await allowedPage.goto(new URL('/apps/sqlite-policy-app', page.url()).href);
  await allowedPage.getByRole('link', { name: 'Sign in', exact: true }).click();
  await allowedPage.getByLabel('Email').fill('allowed@example.test');
  await allowedPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(allowedPage.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  const deniedContext = await page.context().browser()!.newContext();
  const deniedPage = await deniedContext.newPage();
  await deniedPage.goto(new URL('/apps/sqlite-policy-app', page.url()).href);
  await deniedPage.getByRole('link', { name: 'Sign in', exact: true }).click();
  await deniedPage.getByLabel('Email').fill('denied@example.test');
  await deniedPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(deniedPage.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await api(
    '/api/workflows/projects/web-apps/access',
    {
      relativePath,
      accessUpdates: [{ uiGraphId: 'release-gate-web-app', allowedEmails: ['denied@example.test'] }],
      preconditions: await preconditions(),
    },
    'PATCH',
  );
  expect((await allowedPage.goto(new URL('/apps/sqlite-policy-app', page.url()).href))!.status()).toBe(403);
  await deniedPage.goto(new URL('/apps/sqlite-policy-app', page.url()).href);
  await expect(deniedPage.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  expect((await readBinding()).appId).toBe(binding.appId);
  // Route absence is checked with a web-app session; unauthenticated requests
  // intentionally receive the sign-in barrier before route lookup.
  expect(
    (await deniedPage.request.get(new URL('/apps/local-upgrade-app', page.url()).href, { maxRedirects: 0 })).status(),
  ).toBe(404);
  await allowedContext.close();
  await deniedContext.close();
  await evidence('web-app-policy');

  const evaluationBase = '/api/workflows/evaluation-runs';
  const libraryBefore = await api(evaluationBase + '/library');
  const evaluationLibrary = {
    version: 1,
    data: {
      version: 1,
      suites: [
        {
          id: 'sqlite-suite',
          name: 'SQLite suite',
          targetGraphId: '59701e85-9052-43e1-a71d-af698ef7c1fe',
          datasetId: 'sqlite-evaluation-dataset',
          inputBindings: [],
          assertions: [],
          evaluators: [],
        },
      ],
      baselines: [],
    },
    datasets: [{ id: 'sqlite-evaluation-dataset', name: 'SQLite dataset', fields: [], cases: [] }],
    migratedLegacyProjectIds: [],
  };
  await api(
    evaluationBase + '/library',
    { expectedRevision: libraryBefore.revision, library: evaluationLibrary },
    'PUT',
  );
  const evaluationRun = {
    version: 2,
    id: 'sqlite-evaluation-run',
    projectId,
    suiteId: 'sqlite-suite',
    suiteName: 'SQLite suite',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    purpose: 'evaluation',
    executionStatus: 'completed',
    qualityStatus: 'not-evaluated',
    qualityReason: { code: 'no-completed-trials', message: 'Controlled persistence fixture' },
    accountingStatus: 'complete',
    provenance: {
      projectFingerprint: 'fixture',
      suiteFingerprint: 'fixture',
      datasetFingerprint: 'fixture',
      targetFingerprint: 'fixture',
      evaluatorFingerprints: {},
      executionMode: 'test',
      accountingComplete: true,
    },
    thresholdResults: [],
    trials: [],
    warnings: [],
  };
  await api(evaluationBase + '/sqlite-evaluation-run', { projectId, run: evaluationRun }, 'PUT');
  const healthBase = '/api/workflows/llm-profile-health';
  const identity = {
    key: 'sqlite-health',
    projectId,
    profileNodeId: 'fixture-profile',
    profileName: 'SQLite profile',
    provider: 'custom',
    model: 'fixture',
    configurationFingerprint: 'fixture',
  };
  const policy = { failureThreshold: 2, failureWindowMs: 86400000, openDurationMs: 86400000, halfOpenLeaseMs: 60000 };
  const permit = await api(healthBase + '/begin', { identity, policy });
  expect(permit.disposition).toBe('allow');
  await api(healthBase + '/finish', { identity, policy, permitId: permit.permitId, outcome: 'unhealthy' });
  const verifyOperational = async () => {
    expect((await api(evaluationBase + '/library')).library).toMatchObject(evaluationLibrary);
    expect(await api(evaluationBase + '/sqlite-evaluation-run?projectId=' + projectId)).toMatchObject(evaluationRun);
    expect(await api(healthBase + '?projectId=' + projectId)).toContainEqual(
      expect.objectContaining({ identity: expect.objectContaining({ key: 'sqlite-health' }), failureCount: 1 }),
    );
  };
  await verifyOperational();
  await evidence('operational-domains');
  const response = await page.request.post('/workflows/local-upgrade-rehearsal', {
    headers: { Authorization: `Bearer ${process.env.RIVET_KEY}`, 'Content-Type': 'application/json' },
    data: JSON.stringify('image-rehearsal-ok'),
  });
  expect(response.ok()).toBe(true);
  const output = await response.json();
  expect(output.value.value.environmentValue).toBe('sqlite-private-setting');
  const variables = await page.request.get('/api/app-settings/environment-variables');
  expect(variables.ok()).toBe(true);
  expect(await variables.text()).not.toContain('sqlite-private-setting');
  const webApp = await page.request.get('/apps/sqlite-policy-app');
  expect(webApp.status()).toBe(401);
  expect(await webApp.text()).toContain('Sign in required');
  const recordings = await page.request.get('/api/workflows/recordings/workflows');
  const workflow = (await recordings.json()).workflows.find(
    (entry: { project?: { relativePath: string } }) => entry.project?.relativePath === relativePath,
  );
  expect(workflow.totalRuns).toBeGreaterThan(0);
  const runs = await page.request.get(
    `/api/workflows/recordings/workflows/${encodeURIComponent(workflow.workflowId)}/runs?page=1&pageSize=50&status=all`,
  );
  const fixture = await loadLocalUpgradeRehearsal(manifest!);
  const sourceRun = (await runs.json()).runs.find((run: { id: string }) => run.id === fixture.sourceRecordingId);
  expect(sourceRun, 'A retained pre-conversion recording must keep its stable identity.').toBeTruthy();
  const replay = await page.request.get(`/api/workflows/recordings/${encodeURIComponent(sourceRun.id)}/replay-project`);
  expect(replay.ok()).toBe(true);
  expect((await runs.json()).runs.some((run: { id: string }) => run.id !== fixture.sourceRecordingId)).toBe(true);
  await evidence('recordings');
  await control('recreate');
  await verifyOperational();
  expect((await execute()).packageValue).toBe(84);
  expect((await execute()).environmentValue).toBe('sqlite-private-setting');
  expect((await load()).datasetsContents).toBe(datasetsContents);
  await control('drop-runtime-cache');
  expect((await execute()).packageValue).toBe(84);
  const tree = await page.request.get('/api/workflows/tree');
  expect(tree.ok()).toBe(true);
  expect(await tree.text()).toContain('sqlite-only-folder');
  await evidence('restart-persistence');
  await control('assert-selected-integrity');
  await evidence('reference-integrity');
  await control('assert-source-unchanged');
  await evidence('retained-source-proof');
  await control('assert-rollback-closed');
  await control('backup-and-restore-selected');
  expect((await execute()).packageValue).toBe(84);
  expect((await execute()).environmentValue).toBe('sqlite-private-setting');
  expect((await load()).datasetsContents).toBe(datasetsContents);
  await verifyOperational();
  expect(await readBinding()).toMatchObject({
    appId: binding.appId,
    slug: 'sqlite-policy-app',
    allowedEmails: ['denied@example.test'],
  });
  await control('assert-selected-integrity');
  await control('assert-rollback-closed');
  await evidence('post-resumption-backup-restore');
});
