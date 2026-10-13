import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlankProjectFile } from '../../studio-server-api/src/routes/workflows/fs-helpers.js';
import { deserializeProject } from '@valerypopoff/rivet2-core';
import { fixtureScript } from './helpers/legacyRestoreArchiveFixture';
import { authenticateIfNeeded } from './helpers/hostedEditorObserve';

test('managed Docker restores a legacy backup through the UI without Kubernetes and executes the restored endpoint', async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_LOCAL_DOCKER_RESTORE !== '1',
    'Requires an explicitly opted-in, disposable Docker installation.',
  );
  test.setTimeout(600_000);
  const { containerServerConfig, containerStorageIdentity } = await import(
    '../../../deploy/studio-server/scripts/lib/container-server-config.mjs'
  );
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const config = containerServerConfig(process.env, 'dev', 'local-storage', root);
  expect(config.project).toBe('rivet-container-test');
  expect(baseURL).toBe(`http://127.0.0.1:${config.port}`);
  const file = path.join(root, '.data/container-server', config.project, 'compose.private.json');
  const compose = (...args: string[]) =>
    execFileSync('docker', ['compose', '-p', config.project, '-f', file, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: 'true' },
    });
  for (const role of ['backend', 'execution', 'evaluation']) {
    const id = compose('ps', '-q', role).trim();
    expect(id).not.toBe('');
    const container = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8', windowsHide: true }))[0];
    expect(container.Config.Labels['rivet.dev/container-installation']).toBe(config.project);
    expect(container.Config.Labels['rivet.dev/storage-identity']).toBe(containerStorageIdentity(config));
    expect(container.Config.Env.some((item: string) => item.startsWith('KUBERNETES_SERVICE_HOST='))).toBe(false);
  }
  const contents = createBlankProjectFile('Local Docker restore fixture');
  const project = deserializeProject(contents)[0];
  const archive = execFileSync(
    'docker',
    [
      'compose',
      '-p',
      config.project,
      '-f',
      file,
      'exec',
      '-T',
      'backend',
      'node',
      '--input-type=module',
      '-e',
      fixtureScript,
    ],
    {
      input: JSON.stringify({ contents, projectId: project.metadata.id }),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  await page.goto('/?restore-legacy-backup');
  await authenticateIfNeeded(page);
  await expect(page.getByLabel('Legacy backup archive')).toBeVisible();
  await page
    .getByLabel('Legacy backup archive')
    .setInputFiles({ name: 'backup.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from(archive, 'base64') });
  await expect(page.getByLabel('Restore confirmation')).toBeVisible({ timeout: 90_000 });
  await page.getByLabel('Restore confirmation').fill('RESTORE LEGACY BACKUP');
  await page.getByRole('button', { name: 'Restore legacy backup', exact: true }).click();
  await expect
    .poll(
      async () => {
        try {
          const response = await page.request.get('/api/legacy-restore');
          if (!response.ok()) return `HTTP ${response.status()}`;
          const status = await response.json();
          if (status.operation?.phase === 'failed') throw new Error(status.operation.message);
          return status.operation?.phase;
        } catch (error) {
          if (error instanceof Error && /ECONNRESET|ECONNREFUSED|socket/.test(error.message)) return 'restarting';
          throw error;
        }
      },
      { timeout: 330_000 },
    )
    .toBe('completed');
  await expect
    .poll(async () => (await page.request.get('/api/config/env/LOCAL_RESTORE_UI_FIXTURE')).status(), {
      timeout: 90_000,
    })
    .toBe(200);
  expect(await (await page.request.get('/api/config/env/LOCAL_RESTORE_UI_FIXTURE')).json()).toEqual({
    value: 'restored-in-kubernetes',
  });
  // The durable journal completes before the final normal-serving restart.
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get('/api/workflows/tree')).status();
        } catch (error) {
          if (error instanceof Error && /ECONNRESET|ECONNREFUSED|socket/.test(error.message)) return 0;
          throw error;
        }
      },
      { timeout: 90_000 },
    )
    .toBe(200);
  const tree = await page.request.get('/api/workflows/tree');
  expect(tree.ok()).toBe(true);
  expect(JSON.stringify(await tree.json())).toContain(project.metadata.id);
  // Completion commits the restore; consumers may still be exiting warmup.
  // Retry only this read-only probe, never the endpoint execution itself.
  await expect
    .poll(
      () => {
        try {
          const ready = JSON.parse(
            compose(
              'exec',
              '-T',
              'execution',
              'node',
              '--input-type=module',
              '-e',
              "const r=await fetch('http://127.0.0.1:8080/readyz',{signal:AbortSignal.timeout(10000)});console.log(JSON.stringify({status:r.status,body:await r.json()}));",
            ),
          );
          return ready.status === 200 && ready.body.restoreWarmup !== true;
        } catch {
          return false;
        }
      },
      { timeout: 330_000 },
    )
    .toBe(true);
  const execution = JSON.parse(
    compose(
      'exec',
      '-T',
      'execution',
      'node',
      '--input-type=module',
      '-e',
      `
    import {createHash} from 'node:crypto';
    const key=process.env.RIVET_KEY;
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+key,'x-rivet-proxy-auth':createHash('sha256').update(key+':proxy-auth').digest('hex'),cookie:'rivet_ui_token='+createHash('sha256').update(key+':ui-session').digest('hex')};
    const run=async(path)=>(await fetch('http://127.0.0.1:8080'+path,{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(15000)})).status;
    console.log(JSON.stringify({publicStatus:await run('/workflows/local-restore-fixture'),internalStatus:await run('/internal/workflows/local-restore-fixture')}));`,
    ),
  );
  expect(execution).toEqual({ publicStatus: 404, internalStatus: 200 });
});
