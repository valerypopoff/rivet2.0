import { expect, test, type Page, type APIResponse } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { deserializeProject } from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';
import type { WorkflowTreeResponse } from '../../studio-server-shared/workflow-types';

import { fixtureScript } from './helpers/legacyRestoreArchiveFixture';

async function waitForCompletedRestore(page: Page) {
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get('/api/legacy-restore');
          // nginx auth_request maps a temporarily unavailable control API to
          // 500; retain the status in the poll result rather than hiding it.
          if ([500, 502, 503, 504].includes(response.status())) return `HTTP ${response.status()} during restart`;
          expect(response.ok()).toBe(true);
          const status = await response.json();
          if (status.operation?.phase === 'failed') throw new Error(status.operation.message);
          return status.operation?.phase;
        } catch (error) {
          if (error instanceof Error && !/ECONNRESET|ECONNREFUSED|socket/.test(error.message)) throw error;
          return 'restarting';
        }
      },
      // Allow the server's five-minute consumer warmup plus transport recovery.
      { timeout: 330_000 },
    )
    .toBe('completed');
}

async function waitForNormalResponse(page: Page, url: string): Promise<APIResponse> {
  let response: APIResponse | undefined;
  await expect
    .poll(
      async () => {
        try {
          response = await page.request.get(url);
          return response.status();
        } catch (error) {
          if (error instanceof Error && !/ECONNRESET|ECONNREFUSED|socket/.test(error.message)) throw error;
          return 0;
        }
      },
      { timeout: 90_000 },
    )
    .toBe(200);
  return response!;
}

// Explicitly destructive opt-in for an owned local launcher installation, never part of normal UI observation.
test('local Kubernetes restores a real legacy archive through the UI and resumes normal serving', async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_LOCAL_KUBERNETES_RESTORE !== '1',
    'Requires an explicitly opted-in disposable local cluster.',
  );
  test.setTimeout(900_000);
  const { buildKubernetesLauncherConfig } = await import(
    '../../../deploy/studio-server/scripts/lib/kubernetes-launcher-config.mjs'
  );
  const config = buildKubernetesLauncherConfig(process.env);
  expect(config.localServices).toBeTruthy();
  expect(baseURL).toBe(`http://127.0.0.1:${config.localPort}`);
  const kubectl = process.env.RIVET_K8S_KUBECTL_BIN || 'kubectl';
  const contextArgs = ['--context', config.context];
  const namespace = JSON.parse(
    execFileSync(kubectl, [...contextArgs, 'get', 'namespace', config.namespace, '-o', 'json'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  expect(namespace.metadata.labels['rivet.dev/local-launcher-owner']).toBe(config.release);
  const pods = JSON.parse(
    execFileSync(
      kubectl,
      [
        ...contextArgs,
        '-n',
        config.namespace,
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/instance=${config.release},app.kubernetes.io/component=backend`,
        '-o',
        'json',
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    ),
  );
  expect(pods.items).toHaveLength(1);
  const bootstrap = pods.items[0].spec.containers.find(
    (container: { name: string }) => container.name === 'backend',
  ).env;
  expect(bootstrap.find((entry: { name: string }) => entry.name === 'RIVET_DEPLOYMENT_STORAGE_ENDPOINT').value).toBe(
    config.objectStorage.endpoint,
  );
  expect(
    bootstrap.find((entry: { name: string }) => entry.name === 'RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING').valueFrom
      .secretKeyRef.name,
  ).toBe(config.secrets.postgresName);
  await page.goto('/?restore-legacy-backup');
  await authenticateIfNeeded(page);
  // Wait for the panel's initial status read before inspecting conditional controls.
  // A pre-deletion validation failure can be cancelled; never cancel uncertain destructive work.
  const cancel = page.getByRole('button', { name: 'Cancel restore', exact: true });
  const retry = page.getByRole('button', { name: 'Retry restore', exact: true });
  await expect(page.getByLabel('Legacy backup archive').or(cancel).or(retry)).toBeVisible();
  // Explicitly opting into this destructive local test also permits resuming a
  // previous failed attempt through the normal durable recovery action.
  if (await retry.isVisible()) {
    await retry.click();
    await waitForCompletedRestore(page);
    await waitForNormalResponse(page, '/api/app-settings/deployment-storage');
    await page.reload();
  }
  if (await cancel.isVisible()) await cancel.click();
  await expect(page.getByLabel('Legacy backup archive')).toBeVisible();
  // Ordinary settings routes correctly remain fenced during recovery. Recheck
  // the authoritative storage once the accepted attempt has completed/cancelled.
  const storageResponse = await waitForNormalResponse(page, '/api/app-settings/deployment-storage');
  expect(storageResponse.ok()).toBe(true);
  const storage = await storageResponse.json();
  expect(storage.deploymentManaged).toBe(true);
  expect(storage.objectStorageEndpoint).toBe(config.objectStorage.endpoint);
  expect(storage.objectStorageBucket).toBe(config.objectStorage.bucket);

  const { createBlankProjectFile } = await import('../../studio-server-api/src/routes/workflows/fs-helpers.js');
  const contents = createBlankProjectFile('Local Kubernetes restore fixture');
  const archive = Buffer.from(
    execFileSync(
      kubectl,
      [
        ...contextArgs,
        '-n',
        config.namespace,
        'exec',
        '-i',
        pods.items[0].metadata.name,
        '--',
        'node',
        '--input-type=module',
        '-e',
        fixtureScript,
      ],
      {
        input: JSON.stringify({ contents, projectId: deserializeProject(contents)[0].metadata.id }),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      },
    ),
    'base64',
  );
  expect(archive.subarray(0, 2).toString('hex')).toBe('1f8b');
  await page
    .getByLabel('Legacy backup archive')
    .setInputFiles({ name: 'backup.tar.gz', mimeType: 'application/gzip', buffer: archive });
  await expect(page.getByLabel('Restore confirmation')).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Restore confirmation').fill('RESTORE LEGACY BACKUP');
  await page.getByRole('button', { name: 'Restore legacy backup', exact: true }).click();
  await waitForCompletedRestore(page);
  // The journal commits completion before the final normal-serving restart.
  const tree = await waitForNormalResponse(page, '/api/workflows/tree');
  await page.reload();
  await expect(page.getByText('Legacy backup restored and verified.', { exact: true })).toBeVisible();
  expect(tree.ok()).toBe(true);
  const treeContents = (await tree.json()) as WorkflowTreeResponse;
  expect(treeContents.projects).toHaveLength(1);
  expect(treeContents.projects[0]).toMatchObject({
    relativePath: 'local-restore-fixture.rivet-project',
    projectMetadataId: deserializeProject(contents)[0].metadata.id,
    settings: { status: 'published', publishedEndpointName: 'local-restore-fixture', endpointAccess: 'internal' },
  });
  const environment = await page.request.get('/api/config/env/LOCAL_RESTORE_UI_FIXTURE');
  expect(environment.ok()).toBe(true);
  expect(await environment.json()).toEqual({ value: 'restored-in-kubernetes' });
  // Execute only the test-owned empty graph, never an arbitrary restored project.
  let executionPod: string;
  await expect
    .poll(
      () => {
        const pods = JSON.parse(
          execFileSync(
            kubectl,
            [
              ...contextArgs,
              '-n',
              config.namespace,
              'get',
              'pods',
              '-l',
              `app.kubernetes.io/instance=${config.release},app.kubernetes.io/component=${config.deploymentProfile === 'single-machine' ? 'backend' : 'execution'}`,
              '-o',
              'json',
            ],
            {
              encoding: 'utf8',
              windowsHide: true,
            },
          ),
        );
        expect(pods.items.length).toBeGreaterThanOrEqual(config.replicas.execution);
        const pod = pods.items.find((item: { status: { containerStatuses?: { ready: boolean }[] } }) =>
          item.status.containerStatuses?.every((container) => container.ready),
        );
        if (!pod) return false;
        try {
          // Retry only read-only readiness probes, never an endpoint execution.
          const ready = JSON.parse(
            execFileSync(
              kubectl,
              [
                ...contextArgs,
                '-n',
                config.namespace,
                'exec',
                pod.metadata.name,
                '-c',
                config.deploymentProfile === 'single-machine' ? 'execution' : 'api',
                '--',
                'node',
                '--input-type=module',
                '-e',
                String.raw`
          const response=await fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/readyz');
          console.log(JSON.stringify({status:response.status,body:await response.json()}));
        `,
              ],
              { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
            ),
          );
          if (ready.status !== 200 || ready.body.restoreWarmup === true) return false;
          executionPod = pod.metadata.name;
          return true;
        } catch (error) {
          return error instanceof Error
            ? `Readiness probe failed: ${error.message.slice(0, 160)}`
            : 'Readiness probe failed';
        }
      },
      { timeout: 330_000 },
    )
    .toBe(true);
  const execution = JSON.parse(
    execFileSync(
      kubectl,
      [
        ...contextArgs,
        '-n',
        config.namespace,
        'exec',
        executionPod!,
        '-c',
        config.deploymentProfile === 'single-machine' ? 'execution' : 'api',
        '--',
        'node',
        '--input-type=module',
        '-e',
        String.raw`
      import { createHash } from 'node:crypto';
      const key=process.env.RIVET_KEY;
      const headers={'Content-Type':'application/json',Authorization:'Bearer '+key,
        'x-rivet-proxy-auth':createHash('sha256').update(key+':proxy-auth').digest('hex'),
        cookie:'rivet_ui_token='+createHash('sha256').update(key+':ui-session').digest('hex')};
      const run=async(path)=>(await fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+path,
        {method:'POST',headers,body:'{}',signal:AbortSignal.timeout(15000)})).status;
      console.log(JSON.stringify({publicStatus:await run('/workflows/local-restore-fixture'),
        internalStatus:await run('/internal/workflows/local-restore-fixture')}));
    `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 45_000 },
    ),
  );
  expect(execution).toEqual({ publicStatus: 404, internalStatus: 200 });
});
