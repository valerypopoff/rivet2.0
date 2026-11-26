import { expect, test, type Page } from '@playwright/test';
import type {
  WorkflowProjectItem,
  WorkflowProjectStatus,
  WorkflowProjectWebAppSummary,
} from '../../studio-server-shared/workflow-types';
import {
  authenticateIfNeeded,
  mockHostedEditorBootstrap,
  openProjectContextMenu,
  waitForDashboardReady,
} from './helpers/hostedEditorObserve';
import { createProjectWebAppsResponse } from './helpers/projectSettingsObserve';

const STATUS_DOT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgb(187, 187, 187)',
  published: 'rgb(126, 226, 148)',
  unpublished_changes: 'rgb(255, 215, 106)',
};

const SUMMARY_ACCENT: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgb(187, 187, 187)',
  published: 'rgb(106, 215, 117)',
  unpublished_changes: 'rgb(250, 212, 120)',
};

for (const session of [
  { mode: 'oauth', email: 'admin@example.test' },
  { mode: 'oauth', email: null },
  { mode: 'key', email: null },
  { mode: 'none', email: null },
]) {
  test(`Server UI access sign out for ${session.mode} session ${session.email ?? 'without OAuth email'}`, async ({
    page,
  }) => {
    await installStatusDotTreeRoute(page, []);
    await installAppSettingsRoute(page);
    await page.route('**/api/app-settings/server-ui-session', (route) => route.fulfill({ json: session }));
    await page.route('**/?editor', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
      }),
    );
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('app-settings-modal');
    await modal.getByRole('tab', { name: 'Rivet Server UI access' }).click();
    const panel = modal.locator('.app-settings-server-ui-access-panel');
    await expect(panel.getByText('Checking sign-in status…')).toHaveCount(0);
    await expect(panel.getByLabel('Server UI admin emails')).toBeEnabled();
    const signOut = panel.getByRole('link', { name: 'Sign out', exact: true });
    if (session.email) {
      await expect(panel.getByText(`Signed in as ${session.email}`)).toBeVisible();
      await expect(signOut).toHaveAttribute('href', '/__rivet_auth/logout?return_to=%2F');
      await expect(panel.getByText('Signing out does not save pending settings changes.')).toBeVisible();
      let settingsWrites = 0;
      page.on('request', (request) => {
        if (request.method() !== 'GET' && request.url().includes('/api/app-settings/')) settingsWrites += 1;
      });
      await panel.getByLabel('Server UI admin emails').fill('pending@example.test');
      await page.route('**/__rivet_auth/logout?return_to=%2F', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<h1>Sign in required</h1>',
        }),
      );
      await signOut.click();
      await expect(page).toHaveURL(/\/__rivet_auth\/logout\?return_to=%2F$/);
      await expect(page.getByRole('heading', { name: 'Sign in required' })).toBeVisible();
      expect(settingsWrites).toBe(0);
    } else {
      await expect(page.getByText('Could not read your sign-in status.')).toHaveCount(0);
      await expect(signOut).toHaveCount(0);
      await expect(panel.getByText(/Signed in as/)).toHaveCount(0);
    }
  });
}

const ACTIVE_PROJECT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgba(255, 255, 255, 0.07)',
  published: 'rgb(45, 54, 49)',
  unpublished_changes: 'rgb(57, 53, 45)',
};

function createStatusProject(status: WorkflowProjectStatus): WorkflowProjectItem {
  const name = `codex-collapsed-dot-${status}`;

  return {
    id: name,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-05-15T10:00:00.000Z',
    settings: {
      status,
      endpointName: `${name}-endpoint`,
      lastPublishedAt: status === 'unpublished' ? null : '2026-05-15T09:00:00.000Z',
      publishedWebApps: [],
    },
  };
}

async function installStatusDotTreeRoute(page: Page, projects: WorkflowProjectItem[]): Promise<void> {
  await mockHostedEditorBootstrap(page);
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        root: '/managed/workflows',
        sync: { epoch: 'playwright-fixture', revision: 0 },
        folders: [],
        projects,
      }),
    });
  });
}

async function installProjectWebAppsRoute(
  page: Page,
  projects: readonly WorkflowProjectItem[],
  webAppsByRelativePath: Record<string, WorkflowProjectWebAppSummary[]>,
): Promise<void> {
  await page.route('**/api/workflows/projects/web-apps**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/workflows/projects/web-apps') {
      await route.fallback();
      return;
    }

    const relativePath = url.searchParams.get('relativePath') ?? '';
    const project = projects.find((item) => item.relativePath === relativePath);
    if (!project) {
      await route.fulfill({ status: 404, json: { error: 'Project not found' } });
      return;
    }
    await route.fulfill({
      json: createProjectWebAppsResponse({
        ...project,
        webApps: webAppsByRelativePath[relativePath] ?? [],
      }),
    });
  });
}

async function installAppSettingsRoute(page: Page): Promise<void> {
  let publicRouteSettings = {
    publishedWorkflowsBasePath: '/workflows',
    latestWorkflowsBasePath: '/workflows-latest',
    publishedAppsBasePath: '/apps',
    latestAppsBasePath: '/apps-latest',
    updatedAt: null as string | null,
    source: 'default',
  };
  const deploymentStorageSettings = {
    storageMode: 'managed',
    artifactsHostPath: '../',
    databaseMode: 'managed',
    databaseSslMode: 'disable',
    databaseConnectionStringConfigured: true,
    storageUrl: '',
    objectStorageBucket: 'rivet',
    objectStorageEndpoint: 'http://minio:9000',
    objectStorageRegion: 'us-east-1',
    objectStoragePrefix: 'workflows/',
    objectStorageForcePathStyle: true,
    deploymentManaged: true,
    storageAccessKeyId: 'fixture-public-id',
    storageAccessKeyConfigured: true,
    updatedAt: null as string | null,
    source: 'default',
  };
  let runtimeLimitSettings = {
    commandTimeoutSeconds: 30,
    maxOutputBytes: 10 * 1024 * 1024,
    proxyReadTimeoutSeconds: 180,
    webAppActionRequestLimitBytes: 100 * 1024 * 1024,
    dockerWaitTimeoutSeconds: 1200,
    updatedAt: null as string | null,
    source: 'default',
  };
  let executorUrlOverrideSettings = {
    executorWsUrl: '',
    remoteDebuggerDefaultWs: '',
    updatedAt: null as string | null,
    source: 'default',
  };
  let workflowEndpointAuthSettings = {
    requireBearerAuth: true,
    updatedAt: null as string | null,
    source: 'default',
  };
  let trustedClientSettings = {
    trustedClients: ['10.20.0.0/16'],
    updatedAt: null as string | null,
    source: 'default',
  };
  let environmentVariableSettings = {
    variables: [] as Array<{
      id: string;
      name: string;
      valueConfigured: boolean;
      browserAccess: boolean;
      overridesPhysicalEnvironment: boolean;
    }>,
    updatedAt: null as string | null,
    source: 'default',
  };
  let environmentVariableValues = new Map<string, string>();

  await page.route('**/api/app-settings/local-upgrade/setup', (route) =>
    route.fulfill({ json: { eligible: false, liveSqlite: false } }),
  );
  await page.route('**/api/legacy-restore', (route) =>
    route.fulfill({ json: { available: false, reason: 'Restore is unavailable in this fixture.' } }),
  );

  await page.route('**/api/config', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/config') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        executorWsUrl: executorUrlOverrideSettings.executorWsUrl || 'ws://127.0.0.1:8081/ws/executor/internal',
        remoteDebuggerDefaultWs:
          executorUrlOverrideSettings.remoteDebuggerDefaultWs || 'ws://127.0.0.1:8081/ws/latest-debugger',
        ...publicRouteSettings,
        webAppsAuthMode: 'ui-gate',
        storageMode: deploymentStorageSettings.storageMode,
        databaseMode: deploymentStorageSettings.databaseMode,
      }),
    });
  });

  await page.route('**/api/app-settings/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    const environmentVariableValueMatch = url.pathname.match(
      /^\/api\/app-settings\/environment-variables\/([^/]+)\/value$/,
    );
    if (environmentVariableValueMatch) {
      const id = decodeURIComponent(environmentVariableValueMatch[1]!);
      const value = environmentVariableValues.get(id);
      await route.fulfill(
        value === undefined
          ? {
              status: 404,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Environment variable not found' }),
            }
          : {
              status: 200,
              contentType: 'application/json',
              headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate',
              },
              body: JSON.stringify({ id, value }),
            },
      );
      return;
    }

    if (url.pathname === '/api/app-settings/environment-variables') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          variables?: Array<{
            id?: string;
            name?: string;
            value?: string;
            browserAccess?: boolean;
          }>;
        };
        const nextValues = new Map<string, string>();
        environmentVariableSettings = {
          variables: (body.variables ?? []).map((entry, index) => {
            const id = entry.id ?? `environment-variable-${index + 1}`;
            nextValues.set(id, entry.value ?? environmentVariableValues.get(id) ?? '');
            return {
              id,
              name: entry.name ?? '',
              valueConfigured: true,
              browserAccess: entry.browserAccess ?? false,
              overridesPhysicalEnvironment: false,
            };
          }),
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        environmentVariableValues = nextValues;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(environmentVariableSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(environmentVariableSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/node-executor-proxy') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          httpProxy?: string;
          httpsProxy?: string;
          noProxy?: string;
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            httpProxy: body.httpProxy ?? '',
            httpsProxy: body.httpsProxy ?? '',
            noProxy: body.noProxy ?? '',
            updatedAt: '2026-06-30T12:01:00.000Z',
            source: 'app-settings',
          }),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          httpProxy: 'http://proxy.example.internal:3128',
          httpsProxy: 'http://proxy.example.internal:3128',
          noProxy: 'localhost,127.0.0.1,::1,api,web,executor,proxy,.svc,.cluster.local',
          updatedAt: '2026-06-30T12:00:00.000Z',
          source: 'app-settings',
        }),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/executor-url-overrides') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          executorWsUrl?: string;
          remoteDebuggerDefaultWs?: string;
        };
        executorUrlOverrideSettings = {
          executorWsUrl: body.executorWsUrl ?? '',
          remoteDebuggerDefaultWs: body.remoteDebuggerDefaultWs ?? '',
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(executorUrlOverrideSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(executorUrlOverrideSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/run-recordings') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          maxPendingWrites?: string | number;
          maxRunsPerEndpoint?: string | number;
          retentionDays?: string | number;
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            maxPendingWrites: Number(body.maxPendingWrites ?? 100),
            maxRunsPerEndpoint: Number(body.maxRunsPerEndpoint ?? 2000),
            retentionDays: Number(body.retentionDays ?? 0),
            updatedAt: '2026-06-30T12:01:00.000Z',
            source: 'app-settings',
          }),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          maxPendingWrites: 100,
          maxRunsPerEndpoint: 2000,
          retentionDays: 0,
          updatedAt: '2026-06-30T12:00:00.000Z',
          source: 'app-settings',
        }),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/public-routes') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          publishedWorkflowsBasePath?: string;
          latestWorkflowsBasePath?: string;
          publishedAppsBasePath?: string;
          latestAppsBasePath?: string;
        };
        const normalizeSlug = (value: unknown, fallback: string) => {
          const normalized = String(value || fallback)
            .trim()
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
          return `/${normalized}`;
        };
        publicRouteSettings = {
          publishedWorkflowsBasePath: normalizeSlug(body.publishedWorkflowsBasePath, 'workflows'),
          latestWorkflowsBasePath: normalizeSlug(body.latestWorkflowsBasePath, 'workflows-latest'),
          publishedAppsBasePath: normalizeSlug(body.publishedAppsBasePath, 'apps'),
          latestAppsBasePath: normalizeSlug(body.latestAppsBasePath, 'apps-latest'),
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(publicRouteSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(publicRouteSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/runtime-limits') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        runtimeLimitSettings = {
          commandTimeoutSeconds: Number(body.commandTimeoutSeconds ?? runtimeLimitSettings.commandTimeoutSeconds),
          maxOutputBytes: Number(body.maxOutputBytes ?? runtimeLimitSettings.maxOutputBytes),
          proxyReadTimeoutSeconds: Number(body.proxyReadTimeoutSeconds ?? runtimeLimitSettings.proxyReadTimeoutSeconds),
          webAppActionRequestLimitBytes: Number(
            body.webAppActionRequestLimitBytes ?? runtimeLimitSettings.webAppActionRequestLimitBytes,
          ),
          dockerWaitTimeoutSeconds: Number(
            body.dockerWaitTimeoutSeconds ?? runtimeLimitSettings.dockerWaitTimeoutSeconds,
          ),
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(runtimeLimitSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(runtimeLimitSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/workflow-endpoint-auth') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          requireBearerAuth?: boolean;
        };
        workflowEndpointAuthSettings = {
          requireBearerAuth: body.requireBearerAuth ?? true,
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(workflowEndpointAuthSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(workflowEndpointAuthSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/trusted-clients/current-request') {
      await route.fulfill({ json: { clientAddress: '10.20.1.2', trusted: true } });
      return;
    }
    if (url.pathname === '/api/app-settings/trusted-clients') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          trustedClients?: string[];
        };
        trustedClientSettings = {
          trustedClients: body.trustedClients ?? [],
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(trustedClientSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(trustedClientSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/deployment-storage') {
      if (method !== 'GET') {
        await route.fulfill({
          status: 400,
          json: { error: 'Storage connections are deployment-owned and read-only.' },
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(deploymentStorageSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/web-app-auth') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            mode: body.mode ?? 'ui-gate',
            provider: body.provider ?? 'external',
            dummyEmail: body.dummyEmail ?? 'local@example.test',
            dummyAllowNonLocalhost: body.dummyAllowNonLocalhost ?? false,
            authorizeUrl: body.authorizeUrl ?? '',
            tokenUrl: body.tokenUrl ?? '',
            userUrl: body.userUrl ?? '',
            clientId: body.clientId ?? '',
            clientSecretConfigured: Boolean(body.clientSecret) || false,
            callbackUrl: body.callbackUrl ?? '',
            scopes: body.scopes ?? 'email',
            emailClaim: body.emailClaim ?? 'email',
            sessionSecretConfigured: Boolean(body.sessionSecret) || false,
            sessionTtlSeconds: Number(body.sessionTtlSeconds ?? 86400),
            clientAuthMethod: body.clientAuthMethod ?? 'body',
            debugLogProfile: body.debugLogProfile ?? false,
            serverUiAdminEmails: body.serverUiAdminEmails ?? [],
            updatedAt: '2026-06-30T12:01:00.000Z',
            source: 'app-settings',
          }),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'ui-gate',
          provider: 'external',
          dummyEmail: 'local@example.test',
          dummyAllowNonLocalhost: false,
          authorizeUrl: '',
          tokenUrl: '',
          userUrl: '',
          clientId: '',
          clientSecretConfigured: false,
          callbackUrl: '',
          scopes: 'email',
          emailClaim: 'email',
          sessionSecretConfigured: false,
          sessionTtlSeconds: 86400,
          clientAuthMethod: 'body',
          debugLogProfile: false,
          serverUiAdminEmails: [],
          updatedAt: null,
          source: 'default',
        }),
      });
      return;
    }

    await route.fallback();
  });
}

async function dispatchProjectOpenedFromEditorFrame(page: Page, path: string): Promise<void> {
  await page.evaluate((projectPath) => {
    const editorFrame = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame');

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'project-opened', path: projectPath },
        origin: window.location.origin,
        source: editorFrame?.contentWindow ?? null,
      }),
    );
  }, path);
}

test.describe('Workflow library layout', () => {
  test('aligns footer labels with root folder text and keeps icons in the left gutter', async ({ page }) => {
    const rootProject = createStatusProject('published');
    const project = {
      ...rootProject,
      relativePath: `Workflows/${rootProject.fileName}`,
      absolutePath: `/managed/workflows/Workflows/${rootProject.fileName}`,
    };
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/managed/workflows',
          sync: { epoch: 'footer-alignment', revision: 0 },
          projects: [],
          folders: [
            {
              id: 'footer-folder',
              name: 'Workflows',
              relativePath: 'Workflows',
              absolutePath: '/managed/workflows/Workflows',
              updatedAt: project.updatedAt,
              folders: [],
              projects: [project],
            },
          ],
        },
      }),
    );
    await page.route('**/?editor', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
      }),
    );
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const bottomActions = page.locator('.workflow-library-panel .panel-bottom-actions');
    await expect(bottomActions.getByRole('button')).toHaveText([
      'Run recordings',
      'Run statistics',
      'Published',
      'Scheduled runs',
      'Settings',
    ]);
    const recordingsButton = bottomActions.getByRole('button', { name: 'Run recordings' });
    const publishedButton = bottomActions.getByRole('button', { name: 'Published', exact: true });
    const settingsButton = bottomActions.getByRole('button', { name: 'Settings', exact: true });
    await expect(recordingsButton.locator('svg')).toHaveCount(1);
    await expect(publishedButton.locator('svg')).toHaveCount(0);
    await expect(settingsButton.locator('svg')).toHaveCount(1);
    await expect(bottomActions.locator('.panel-bottom-button-label')).toHaveCount(5);
    const folderRow = page.locator('.workflow-library-panel .folder-row');
    const folderLabel = folderRow.locator('.label');
    await expect(folderLabel).toBeVisible();
    for (const width of [1600, 700]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const expanded of [true, false]) {
        await folderRow.click();
        await expect(page.locator('.workflow-library-panel .project-row')).toHaveCount(expanded ? 1 : 0);
        const folderBox = await folderLabel.boundingBox();
        expect(folderBox).not.toBeNull();
        for (const label of await bottomActions.locator('.panel-bottom-button-label').all()) {
          await expect(label).toBeVisible();
          const labelBox = await label.boundingBox();
          expect(labelBox).not.toBeNull();
          expect(Math.abs(labelBox!.x - folderBox!.x)).toBeLessThanOrEqual(1);
        }
      }
      for (const button of [recordingsButton, settingsButton]) {
        const iconBox = await button.locator('svg').boundingBox();
        const labelBox = await button.locator('.panel-bottom-button-label').boundingBox();
        const buttonBox = await button.boundingBox();
        expect(iconBox).not.toBeNull();
        expect(labelBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        expect(iconBox!.x + iconBox!.width).toBeLessThan(labelBox!.x);
        expect(iconBox!.x).toBeGreaterThanOrEqual(buttonBox!.x);
      }
    }
  });

  test('trusted clients explains legacy hosts and unavailable client identity', async ({ page }) => {
    await installAppSettingsRoute(page);
    await page.route('**/api/app-settings/trusted-clients', (route) =>
      route.fulfill({
        json: {
          trustedClients: [],
          legacyTrustedHosts: ['old.internal.example'],
          source: 'app-settings',
          updatedAt: null,
        },
      }),
    );
    await page.route('**/api/app-settings/trusted-clients/current-request', (route) =>
      route.fulfill({
        json: { clientAddress: null, trusted: false },
      }),
    );
    await page.route('**/?editor', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
      }),
    );
    await page.goto('/');
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('app-settings-modal');
    await expect(modal.getByLabel('Trusted clients', { exact: true })).toHaveValue('');
    await expect(modal).toContainText('Hostname-only access has been disabled. Previous entries: old.internal.example');
    await expect(modal).toContainText('Unavailable — trusted access cannot be determined for this connection.');
  });

  test('collapses from the full header row into a clickable narrow rail', async ({ page }) => {
    await installAppSettingsRoute(page);
    // This dashboard/settings fixture does not exercise the embedded editor.
    await page.route('**/?editor', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
      }),
    );

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(Math.round(headerBox!.height)).toBe(37);
    await expect(header).toHaveCSS('border-bottom-width', '0px');

    const collapseButton = page.getByRole('button', { name: 'Collapse folders pane' });
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(collapseButton).toBeVisible();
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    await expect(collapseButton.locator('path').last()).toHaveAttribute('d', 'M5.25 4.75v6.5');

    const collapseButtonBox = await collapseButton.boundingBox();
    const titleBox = await title.boundingBox();
    expect(collapseButtonBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(collapseButtonBox!.x).toBeLessThan(titleBox!.x);

    const bottomActions = page.locator('.workflow-library-panel .panel-bottom-actions');
    await expect(bottomActions).toHaveCSS('padding-bottom', '24px');

    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const appSettingsModal = page.locator('[data-testid="app-settings-modal"]');
    await expect(appSettingsModal).toBeVisible();
    const appSettingsActions = appSettingsModal.locator('.app-settings-panel-region > .app-settings-actions-row');
    await expect(appSettingsModal.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    const appSettingsTabList = appSettingsModal.getByRole('tablist', { name: 'App settings sections' });
    await expect(appSettingsTabList).toHaveAttribute('aria-orientation', 'vertical');
    const [generalTabBox, storageTabBox, panelRegionBox] = await Promise.all([
      appSettingsModal.getByRole('tab', { name: 'General' }).boundingBox(),
      appSettingsModal.getByRole('tab', { name: 'Storage', exact: true }).boundingBox(),
      appSettingsModal.locator('.app-settings-panel-region').boundingBox(),
    ]);
    expect(generalTabBox).not.toBeNull();
    expect(storageTabBox).not.toBeNull();
    expect(panelRegionBox).not.toBeNull();
    expect(storageTabBox!.y).toBeGreaterThan(generalTabBox!.y + generalTabBox!.height - 2);
    expect(generalTabBox!.x + generalTabBox!.width).toBeLessThan(panelRegionBox!.x);
    await expect(appSettingsModal).toContainText('Rivet Studio Server');
    await expect(appSettingsModal.locator('section[aria-label="Routes"]')).toHaveCount(0);
    await expect(appSettingsModal.locator('section[aria-label="Access"]')).toHaveCount(0);
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsModal.getByLabel('Trusted clients')).toHaveValue('10.20.0.0/16');
    await expect(appSettingsModal.getByText('Verified address for this connection: 10.20.1.2')).toBeVisible();
    await appSettingsModal.getByLabel('Trusted clients').fill('10.20.0.0/16\n192.0.2.15');
    await appSettingsActions.getByRole('button', { name: 'Revert' }).click();
    await expect(appSettingsModal.getByLabel('Trusted clients')).toHaveValue('10.20.0.0/16');
    await appSettingsModal.getByLabel('Trusted clients').fill('10.20.0.0/16\n192.0.2.15');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Trusted clients')).toHaveValue('10.20.0.0/16\n192.0.2.15');

    await appSettingsModal.getByRole('tab', { name: 'Shell execution' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Shell execution' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      appSettingsModal.getByText('They do not limit workflows, web apps, LLM calls, HTTP Call nodes, or endpoints.'),
    ).toBeVisible();
    await expect(appSettingsModal.getByLabel('Command timeout in seconds')).toHaveValue('30');
    await expect(appSettingsModal.getByLabel('Maximum captured output in MiB')).toHaveValue('10');
    await appSettingsModal.getByLabel('Command timeout in seconds').fill('45');
    await appSettingsActions.getByRole('button', { name: 'Revert' }).click();
    await expect(appSettingsModal.getByLabel('Command timeout in seconds')).toHaveValue('30');
    await appSettingsModal.getByLabel('Command timeout in seconds').fill('45');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Command timeout in seconds')).toHaveValue('45');

    await appSettingsModal.getByRole('tab', { name: 'Environment variables' }).click();
    await expect(appSettingsModal.getByText('No UI-managed environment variables are configured.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Add variable' }).click();
    await appSettingsModal.getByLabel('Environment variable 1 name').fill('APP_TEST_KEY');
    await appSettingsModal.getByLabel('Environment variable 1 value').fill('saved-only-value');
    await appSettingsModal.getByLabel('Allow Browser executor access for APP_TEST_KEY').check();
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toContainText(
      'New runs now use these values.',
    );
    const environmentVariableRow = appSettingsModal.locator('.app-settings-environment-variable').first();
    const environmentVariableRowBounds = await environmentVariableRow.boundingBox();
    expect(environmentVariableRowBounds?.height).toBeLessThanOrEqual(56);
    await expect(appSettingsModal.getByLabel('Environment variable 1 value')).toHaveValue('');
    await expect(appSettingsModal.getByLabel('Environment variable 1 value')).toHaveAttribute(
      'placeholder',
      '••••••••',
    );
    await expect(appSettingsModal).not.toContainText('saved-only-value');
    await appSettingsModal.getByRole('button', { name: 'Show value for APP_TEST_KEY' }).click();
    await expect(appSettingsModal.getByLabel('Environment variable 1 value')).toHaveValue('saved-only-value');
    await appSettingsModal.getByRole('button', { name: 'Hide value for APP_TEST_KEY' }).click();
    await expect(appSettingsModal.getByLabel('Environment variable 1 value')).toHaveValue('');
    await appSettingsModal.getByLabel('Environment variable 1 value').fill('replacement-value');
    await expect(appSettingsModal.getByLabel('Environment variable 1 value')).toHaveAttribute('type', 'text');
    await expect(appSettingsModal.getByLabel('Environment variable 1 value')).toHaveValue('replacement-value');

    await appSettingsModal.getByRole('tab', { name: 'Endpoints' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Endpoints' })).toHaveAttribute('aria-selected', 'true');
    await expect(
      appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-section-title'),
    ).toContainText(['Routes', 'Access control', 'HTTP request timeout']);
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveValue('workflows');
    await expect(appSettingsModal.getByLabel('Latest saved workflow endpoint URL slug')).toHaveValue(
      'workflows-latest',
    );
    await expect(
      appSettingsModal.getByLabel('Require Authorization: Bearer <Rivet key> for workflow endpoint calls'),
    ).toBeChecked();
    await expect(appSettingsModal.getByLabel('Proxy read timeout in seconds')).toHaveValue('180');
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveCount(0);
    await appSettingsModal.getByLabel('Published workflow endpoint URL slug').fill('public-workflows');
    await appSettingsModal
      .getByLabel('Require Authorization: Bearer <Rivet key> for workflow endpoint calls')
      .uncheck();
    await appSettingsModal.getByLabel('Proxy read timeout in seconds').fill('240');
    await expect(appSettingsActions).toHaveCount(1);
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveValue('public-workflows');
    await expect(
      appSettingsModal.getByLabel('Require Authorization: Bearer <Rivet key> for workflow endpoint calls'),
    ).not.toBeChecked();
    await expect
      .poll(async () => {
        const [contentBox, sectionBox] = await Promise.all([
          appSettingsModal.locator('.app-settings-panel-region').boundingBox(),
          appSettingsModal
            .locator('.app-settings-workflow-endpoints-panel .app-settings-section')
            .first()
            .boundingBox(),
        ]);
        return contentBox && sectionBox ? sectionBox.width / contentBox.width : 0;
      })
      .toBeGreaterThan(0.9);

    await appSettingsModal.getByRole('tab', { name: 'Storage', exact: true }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Storage', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      appSettingsModal.getByText('S3-compatible object storage + PostgreSQL', { exact: true }),
    ).toBeVisible();
    await expect(appSettingsModal.getByRole('button', { name: 'Local folders' })).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Host artifacts folder')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Object storage bucket')).toHaveValue('rivet');
    await expect(appSettingsModal.getByLabel('Object storage bucket')).toHaveAttribute('readonly', '');
    await expect(appSettingsModal.getByLabel('Object storage secret access key')).toHaveAttribute(
      'placeholder',
      'Configured (hidden)',
    );
    await expect(appSettingsModal.getByLabel('PostgreSQL connection string')).toHaveAttribute('readonly', '');
    await expect(appSettingsModal.getByRole('heading', { name: 'How to use external storage' })).toBeVisible();
    await expect(appSettingsModal.getByRole('tab', { name: 'Migration', exact: true })).toHaveCount(0);
    await expect(appSettingsActions).toHaveCount(0);
    const storageFieldGrids = appSettingsModal.locator('.app-settings-storage-panel .app-settings-field-grid');
    await expect(storageFieldGrids.first()).toHaveCSS('gap', '18px');

    await appSettingsModal.getByRole('tab', { name: 'Run recordings' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Run recordings' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section-title')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Queued recording writes')).toHaveValue('100');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep latest runs' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(appSettingsModal.getByRole('button', { name: 'Keep all runs' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveValue('2000');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep forever' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(appSettingsModal.getByRole('button', { name: 'Keep for some time' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveCount(0);
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-field-grid')).toHaveCSS(
      'gap',
      '18px',
    );
    await expect(
      appSettingsModal.getByText(
        'Keeping only the newest runs for each endpoint. Older runs are removed during cleanup.',
      ),
    ).toBeVisible();
    await expect(
      appSettingsModal.getByText('Recordings are kept indefinitely unless another saved limit removes them.'),
    ).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Keep all runs' }).click();
    await expect(appSettingsModal.getByText('Keeping every recorded run for each endpoint.')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveCount(0);
    await appSettingsModal.getByRole('button', { name: 'Keep latest runs' }).click();
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveValue('2000');
    await appSettingsModal.getByRole('button', { name: 'Keep for some time' }).click();
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveValue('14');
    await expect(
      appSettingsModal.getByText('Recordings older than the selected number of days are removed during cleanup.'),
    ).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Keep forever' }).click();
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveCount(0);
    await expect
      .poll(async () => {
        const [contentBox, sectionBox] = await Promise.all([
          appSettingsModal.locator('.app-settings-panel-region').boundingBox(),
          appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section').boundingBox(),
        ]);
        return contentBox && sectionBox ? sectionBox.width / contentBox.width : 0;
      })
      .toBeGreaterThan(0.9);
    await appSettingsModal.getByLabel('Queued recording writes').fill('101');
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('min-width', '84px');
    await expect(appSettingsActions).toHaveCSS('border-top-width', '1px');
    await expect(appSettingsActions).toHaveCSS('margin-top', '8px');
    await expect(appSettingsActions).toHaveCSS('padding-top', '14px');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(
      appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section > .project-settings-success'),
    ).toHaveCount(0);
    await appSettingsModal.getByRole('tab', { name: 'Node executor proxy' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Node executor proxy' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const websocketOverrideSection = appSettingsModal.locator('.app-settings-proxy-panel .app-settings-section', {
      hasText: 'Websocket URL overrides',
    });
    await expect(websocketOverrideSection.locator('.app-settings-section-title')).toHaveText('Websocket URL overrides');
    await expect(appSettingsModal.getByText('HTTP_PROXY')).toBeVisible();
    await expect(
      appSettingsModal
        .locator('.app-settings-proxy-panel .app-settings-section')
        .first()
        .locator('.app-settings-field-grid'),
    ).toHaveCSS('gap', '18px');
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsModal.getByRole('textbox', { name: 'HTTP_PROXY' })).toHaveValue(
      'http://proxy.example.internal:3128',
    );
    await expect(appSettingsModal.getByText('NO_PROXY')).toBeVisible();
    await expect(appSettingsModal.getByRole('textbox', { name: 'NO_PROXY' })).toHaveValue(
      'localhost,127.0.0.1,::1,api,web,executor,proxy,.svc,.cluster.local',
    );
    await expect(
      appSettingsModal.getByText('In Kubernetes, include cluster-local suffixes such as .svc and .cluster.local'),
    ).toBeVisible();
    await expect(appSettingsModal.getByText('Websocket URL overrides')).toBeVisible();
    await expect(appSettingsModal.getByRole('textbox', { name: 'Node executor websocket URL override' })).toHaveValue(
      '',
    );
    await expect(appSettingsModal.getByRole('textbox', { name: 'Remote Debugger websocket URL override' })).toHaveValue(
      '',
    );
    await expect(appSettingsModal.getByText('Active URL: ws://127.0.0.1:8081/ws/executor/internal.')).toBeVisible();
    await appSettingsModal.getByRole('textbox', { name: 'HTTP_PROXY' }).fill('http://proxy.example.internal:3129');
    await appSettingsModal
      .getByRole('textbox', { name: 'Remote Debugger websocket URL override' })
      .fill('wss://debugger.example.test/ws/latest-debugger');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText(
      'Saved. Reload the editor to apply websocket URL overrides to active sessions.',
    );
    await expect(
      appSettingsModal.getByText('Active URL: wss://debugger.example.test/ws/latest-debugger.'),
    ).toBeVisible();

    await appSettingsModal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Web apps' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-section-title')).toContainText([
      'Routes',
      'Auth',
      'Button data',
    ]);
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveValue('apps');
    await expect(appSettingsModal.getByLabel('Maximum web app button data in MiB')).toHaveValue('100');
    await expect(appSettingsModal.getByLabel('Latest saved changes URL slug')).toHaveValue('apps-latest');
    const appRouteRow = appSettingsModal
      .locator('.app-settings-web-apps-panel .app-settings-prefixed-input-row')
      .first();
    await expect(appRouteRow).toHaveCSS('display', 'flex');
    await expect
      .poll(async () => {
        const [prefixBox, inputBox] = await Promise.all([
          appRouteRow.locator('.project-settings-url-prefix').boundingBox(),
          appRouteRow.locator('.project-settings-input').boundingBox(),
        ]);
        return prefixBox && inputBox
          ? Math.max(Math.abs(prefixBox.y - inputBox.y), Math.abs(prefixBox.height - inputBox.height))
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(1);
    await appSettingsModal.getByLabel('Published web app URL slug').fill('public-apps');
    await expect(appSettingsModal.getByRole('button', { name: 'Key' })).toHaveAttribute('aria-pressed', 'true');
    const webAppAuthMode = appSettingsModal.getByRole('group', { name: 'Web app auth mode' });
    await expect(webAppAuthMode).toHaveClass(/segmented-control/);
    await expect(webAppAuthMode.getByRole('button', { name: 'Key' })).toHaveCSS('height', '28px');
    await expect(appSettingsModal.getByText('Visitors enter the Rivet key before opening web apps.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'OAuth' }).click();
    await expect(
      appSettingsModal.getByText(
        "Visitors sign in with the provider configured in the OAuth tab and are checked against each web app's allowed-email list.",
      ),
    ).toBeVisible();

    const webAppButtonDataSection = appSettingsModal.locator('section[aria-label="Web app button data"]');
    await expect(webAppButtonDataSection.getByText('Large payloads are buffered in the API process.')).toBeVisible();
    await appSettingsModal.getByLabel('Maximum web app button data in MiB').fill('200');
    await expect(appSettingsActions).toHaveCount(1);
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText(
      'Saved. Nginx reloads shortly; restart the API to apply the new WebSocket message limit.',
    );
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveValue('public-apps');

    await appSettingsModal.getByRole('tab', { name: 'OAuth' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'OAuth' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-oauth-panel .app-settings-section-title')).toHaveText(
      'Provider',
    );
    await expect(appSettingsModal.getByText('These settings are used by web apps in OAuth mode')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Server UI admin emails')).toHaveCount(0);
    await expect(appSettingsModal).toHaveCSS('overflow-y', 'hidden');
    await expect(page.locator('[data-testid="app-settings-modal--body"]')).toHaveCSS('overflow-y', 'hidden');
    const settingsTabList = appSettingsModal.locator('.app-settings-tab-list');
    const settingsPanelRegion = appSettingsModal.locator('.app-settings-panel-region');
    const tabsBeforePanelScroll = await settingsTabList.boundingBox();
    await settingsPanelRegion.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => {
        const tabsAfterPanelScroll = await settingsTabList.boundingBox();
        return tabsBeforePanelScroll && tabsAfterPanelScroll
          ? Math.abs(tabsAfterPanelScroll.y - tabsBeforePanelScroll.y)
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThanOrEqual(1);
    await settingsPanelRegion.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(appSettingsModal.getByRole('button', { name: 'External provider' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await appSettingsModal.getByRole('button', { name: 'Local dummy' }).click();
    await expect(appSettingsModal.getByText('Default test email')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Default test email')).toHaveValue('local@example.test');
    await appSettingsModal.getByLabel('Session signing secret').fill('local-session-secret');
    await expect(appSettingsActions).toHaveCount(1);
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');

    await appSettingsModal.getByRole('tab', { name: 'Rivet Server UI access' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Rivet Server UI access' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(appSettingsModal.getByText('RIVET_SERVER_UI_AUTH_MODE', { exact: true })).toBeVisible();
    const serverUiEmails = appSettingsModal.getByLabel('Server UI admin emails');
    const serverUiEmailBorder = await serverUiEmails.evaluate((element) => getComputedStyle(element).borderColor);
    await serverUiEmails.focus();
    await expect(serverUiEmails).toHaveCSS('border-color', serverUiEmailBorder);
    await serverUiEmails.fill('admin@example.test');
    await expect(appSettingsActions).toHaveCount(1);
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');

    await appSettingsModal.getByRole('tab', { name: 'Shell execution' }).click();
    const maxOutputInput = appSettingsModal.getByLabel('Maximum captured output in MiB');
    await maxOutputInput.click();
    await maxOutputInput.press('ControlOrMeta+A');
    await maxOutputInput.pressSequentially('11');
    await expect(maxOutputInput).toHaveValue('11');

    await appSettingsModal.getByRole('tab', { name: 'Docker' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Docker' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-docker-panel .app-settings-section-title')).toHaveCount(0);
    const dockerTimeoutInput = appSettingsModal.getByRole('spinbutton', {
      name: 'Docker startup wait timeout in seconds',
    });
    await expect(dockerTimeoutInput).toHaveValue('1200');
    await expect(appSettingsModal.getByText('Kubernetes ignores this setting.')).toBeVisible();
    await dockerTimeoutInput.fill('1500');
    await expect(dockerTimeoutInput).toHaveValue('1500');
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsActions).toHaveCSS('border-top-width', '1px');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');

    await expect(appSettingsModal.getByRole('tab', { name: 'Shell execution' })).toBeVisible();
    await appSettingsModal.getByRole('tab', { name: 'Shell execution' }).click();
    await expect(appSettingsModal.getByLabel('Maximum captured output in MiB')).toHaveValue('11');
    await expect(appSettingsActions.getByRole('button', { name: 'Save' })).toBeEnabled();
    await expect(appSettingsModal).toContainText('OAuth');
    await page.getByRole('button', { name: 'Close app settings' }).click();
    await expect(appSettingsModal).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'About' })).toHaveCount(0);

    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const expandButton = page.getByRole('button', { name: 'Expand folders pane' });
    await expect(expandButton).toBeVisible();
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(expandButton.locator('path')).toHaveAttribute('d', 'M6 4.5 9.5 8 6 11.5');
    await expect(header).toHaveCount(1);
    await expect(title).toHaveCount(1);
    await expect(header).toBeHidden();
    await expect(title).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show main panel' })).toHaveCount(0);

    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    const sidebarBox = await sidebar.boundingBox();
    const expandButtonBox = await expandButton.boundingBox();
    const expandIconBox = await expandButton.locator('svg').boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(expandButtonBox).not.toBeNull();
    expect(expandIconBox).not.toBeNull();
    expect(Math.round(expandButtonBox!.width)).toBe(Math.round(sidebarBox!.width));
    expect(Math.round(expandButtonBox!.height)).toBe(Math.round(sidebarBox!.height));
    expect(
      Math.abs(expandIconBox!.y + expandIconBox!.height / 2 - (sidebarBox!.y + sidebarBox!.height / 2)),
    ).toBeLessThan(2);

    await page.mouse.click(sidebarBox!.x + sidebarBox!.width / 2, sidebarBox!.y + sidebarBox!.height - 20);

    const titleVisibilityDuringExpand = await title.evaluate((element) => window.getComputedStyle(element).visibility);
    expect(titleVisibilityDuringExpand).toBe('hidden');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
    await expect(page.getByRole('button', { name: 'Collapse folders pane' })).toBeVisible();
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Rivet Studio Server');
  });

  for (const storageChoice of ['local-storage', 'external-storage']) {
    test(`shows ${storageChoice} connections and credentials as read-only`, async ({ page }) => {
      let storageWrites = 0;
      page.on('request', (request) => {
        if (request.url().includes('/api/app-settings/deployment-storage') && request.method() !== 'GET')
          storageWrites++;
      });
      await installAppSettingsRoute(page);
      await page.route('**/api/app-settings/deployment-storage', (route) =>
        route.fulfill({
          json: {
            storageMode: 'managed',
            artifactsHostPath: '../',
            databaseMode: 'managed',
            databaseSslMode: storageChoice === 'local-storage' ? 'disable' : 'verify-full',
            databaseConnectionStringConfigured: true,
            storageUrl: 'https://rivet.s3.us-east-1.amazonaws.com',
            objectStorageBucket: 'rivet',
            objectStorageEndpoint: storageChoice === 'local-storage' ? 'http://minio:9000' : '',
            objectStorageRegion: 'us-east-1',
            objectStoragePrefix: 'workflows/',
            objectStorageForcePathStyle: storageChoice === 'local-storage',
            deploymentManaged: true,
            storageAccessKeyId: 'access',
            storageAccessKeyConfigured: true,
            databaseConnectionString: 'private-database-secret-must-not-be-rendered',
            storageAccessKey: 'private-s3-secret-must-not-be-rendered',
            updatedAt: null,
            source: 'app-settings',
          },
        }),
      );
      await page.route('**/?editor', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<script>setInterval(() => parent.postMessage({type:"editor-ready",editorInstanceId:"fixture-editor"}, location.origin), 100)</script>',
        }),
      );
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const modal = page.getByTestId('app-settings-modal');
      await modal.getByRole('tab', { name: 'Storage', exact: true }).click();
      await expect(modal.getByText('S3-compatible object storage + PostgreSQL', { exact: true })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Local folders' })).toHaveCount(0);
      await expect(modal.getByRole('button', { name: 'Local Docker Postgres' })).toHaveCount(0);
      await expect(modal.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      for (const label of [
        'Object storage bucket',
        'Object storage access key ID',
        'Object storage secret access key',
        'PostgreSQL connection string',
        'PostgreSQL SSL',
        'S3 address style',
      ]) {
        await expect(modal.getByLabel(label)).toHaveAttribute('readonly', '');
      }
      await expect(modal.getByLabel('PostgreSQL connection string')).toHaveValue('');
      await expect(modal.getByLabel('PostgreSQL connection string')).toHaveAttribute(
        'placeholder',
        'Configured (hidden)',
      );
      await expect(modal.getByLabel('Object storage secret access key')).toHaveValue('');
      await expect(modal).not.toContainText('private-database-secret-must-not-be-rendered');
      await expect(modal).not.toContainText('private-s3-secret-must-not-be-rendered');
      await expect(modal.getByLabel('PostgreSQL SSL')).toHaveValue(
        storageChoice === 'local-storage' ? 'Disabled' : 'Verify full',
      );
      await expect(modal.getByRole('heading', { name: 'How to use external storage' })).toBeVisible();
      await expect(modal.getByText('yarn studio-server:dev:external-storage', { exact: true })).toBeVisible();
      await expect(modal).toContainText('does not move existing data');
      await expect(modal.getByRole('tab', { name: 'Migration', exact: true })).toHaveCount(0);
      await expect(modal.getByRole('tab', { name: 'Local storage upgrade', exact: true })).toHaveCount(0);
      await modal.getByLabel('Object storage bucket').focus();
      await page.keyboard.type('must-not-edit');
      await expect(modal.getByLabel('Object storage bucket')).toHaveValue('rivet');
      expect(storageWrites).toBe(0);
    });
  }

  test('Storage loading and read failures do not show legacy controls or an endless loading message', async ({
    page,
  }) => {
    await installAppSettingsRoute(page);
    let failRead: (() => Promise<void>) | undefined;
    await page.route('**/api/app-settings/deployment-storage', (route) => {
      failRead = () => route.fulfill({ status: 503, json: { error: 'Storage configuration unavailable.' } });
    });
    await page.route('**/?editor', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div>Fixture editor</div>' }),
    );
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('app-settings-modal');
    await modal.getByRole('tab', { name: 'Storage', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('Loading storage configuration…');
    await expect(modal.getByRole('button', { name: 'Local folders' })).toHaveCount(0);
    await expect(modal.getByLabel('Object storage secret access key')).toHaveCount(0);
    await expect.poll(() => !!failRead).toBe(true);
    await failRead!();
    await expect(modal.getByRole('alert')).toContainText('Storage configuration unavailable.');
    await expect(modal.getByText('Loading storage configuration…')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  });

  test('resizes with a wider drag target and folds while dragging below half the minimum width', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const resizer = page.locator('.dashboard-sidebar-resizer');
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(resizer).toBeVisible();

    const resizerBox = await resizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    expect(Math.round(resizerBox!.width)).toBeGreaterThanOrEqual(14);

    const dragY = resizerBox!.y + 48;
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2, dragY);
    await page.mouse.down();

    await page.mouse.move(90, dragY, { steps: 4 });
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    await expect(title).toBeHidden();

    await page.mouse.move(280, dragY, { steps: 6 });
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
    await page.mouse.up();

    await expect(title).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
  });

  test('shows the opened project status as a collapsed rail dot', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    await installStatusDotTreeRoute(page, projects);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await expect(page.getByRole('button', { name: projects[0].name, exact: true })).toBeEnabled({ timeout: 180_000 });

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();

    await dispatchProjectOpenedFromEditorFrame(page, projects[0].absolutePath);
    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const statusDot = page.locator('.workflow-library-panel .collapsed-strip-status-dot');
    await expect(statusDot).toBeHidden();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);

    for (const project of projects.slice(1)) {
      await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);
      await expect(statusDot).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(statusDot).toHaveCSS('background-color', STATUS_DOT_BACKGROUND[project.settings.status]);
    }

    const sidebarBox = await sidebar.boundingBox();
    const statusDotBox = await statusDot.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(statusDotBox).not.toBeNull();
    expect(Math.round(statusDotBox!.width)).toBe(12);
    expect(Math.round(statusDotBox!.height)).toBe(12);
    expect(Math.abs(statusDotBox!.x + statusDotBox!.width / 2 - (sidebarBox!.x + sidebarBox!.width / 2))).toBeLessThan(
      2,
    );
    expect(Math.abs(statusDotBox!.y + statusDotBox!.height / 2 - (sidebarBox!.y + 18.5))).toBeLessThan(2);
  });

  test('renders publication states with separate Settings and reference-details actions', async ({ page }) => {
    const cases = [
      { key: 'local', own: 'unpublished_changes', text: 'Unpublished changes', tone: 'unpublished_changes', refs: 0 },
      {
        key: 'references',
        own: 'published',
        text: 'Unpublished changes in 3 referenced projects',
        tone: 'unpublished_changes',
        refs: 3,
      },
      {
        key: 'both',
        own: 'unpublished_changes',
        text: 'Unpublished changes here and in 3 referenced projects',
        tone: 'unpublished_changes',
        refs: 3,
      },
      { key: 'published', own: 'published', text: 'Published', tone: 'published', refs: 0 },
      { key: 'contributor', own: 'unpublished', text: 'Contributes to published', tone: 'published', refs: 0 },
      {
        key: 'changed-contributor',
        own: 'unpublished',
        text: 'Contributes to unpublished changes',
        tone: 'unpublished_changes',
        refs: 0,
      },
      { key: 'unpublished', own: 'unpublished', text: 'Unpublished', tone: 'unpublished', refs: 0 },
    ] as const;
    const makeProject = (key: string, own: WorkflowProjectStatus) => {
      const project = createStatusProject(own);
      project.id = project.projectMetadataId = `summary-${key}`;
      project.name = `Summary ${key}`;
      project.fileName = `${key}.rivet-project`;
      project.relativePath = project.fileName;
      project.absolutePath = `/managed/workflows/${project.fileName}`;
      project.revisionId = 'revision-1';
      project.settings.publicationVersion = '0';
      project.settings.endpointName = `${key}-endpoint`;
      return project;
    };
    const projects = cases.map((item) => makeProject(item.key, item.own));
    const local = projects[0]!;
    local.stats = { graphCount: 2, totalNodeCount: 4, webAppCount: 1 };
    local.settings.publishedWebApps = [
      {
        uiGraphId: 'app',
        uiGraphName: 'App',
        slug: 'live-app',
        publishedAt: '2026-05-15T09:00:00.000Z',
        allowedEmails: [],
      },
    ];
    const owner = makeProject('owner', 'published');
    projects.push(owner);
    await installStatusDotTreeRoute(page, projects);
    await installProjectWebAppsRoute(page, projects, {
      [local.relativePath]: [
        {
          uiGraphId: 'app',
          name: 'Live app',
          publishedSlug: 'live-app',
          publishedAt: '2026-05-15T09:00:00.000Z',
          allowedEmails: [],
          status: 'published',
          isMissingFromProject: false,
        },
      ],
    });
    await page.route('**/api/workflows/projects/reference-overview', (route) =>
      route.fulfill({
        json: {
          complete: true,
          bundles: [],
          endpoints: [
            ...cases
              .filter((item) => item.refs > 0)
              .map((item) => ({
                projectId: `summary-${item.key}`,
                coverage: 'complete',
                dependencies: Array.from({ length: item.refs }, (_, index) => ({
                  projectId: `target-${index}`,
                  name: `Target ${index}`,
                  relativePath: null,
                  changed: true,
                  unavailable: false,
                })),
              })),
            {
              projectId: owner.projectMetadataId,
              coverage: 'complete',
              dependencies: [
                {
                  projectId: 'summary-contributor',
                  name: 'Contributor',
                  relativePath: 'contributor.rivet-project',
                  changed: false,
                  unavailable: false,
                },
                {
                  projectId: 'summary-changed-contributor',
                  name: 'Changed contributor',
                  relativePath: 'changed-contributor.rivet-project',
                  changed: true,
                  unavailable: false,
                },
              ],
            },
          ],
        },
      }),
    );
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const summary = page.locator('.active-project-section');
    for (const item of cases) {
      await openProjectContextMenu(page, `Summary ${item.key}`);
      const strip = summary.locator('.project-summary-settings-strip');
      const settingsButton = strip.getByRole('button', { name: 'Settings', exact: true });
      await expect(summary.locator('.project-summary-status-text')).toHaveText(item.text);
      const menu = page.getByRole('menu', { name: `Actions for Summary ${item.key}`, exact: true });
      await expect(menu).toHaveCSS('width', '274px');
      await expect(settingsButton).toHaveAttribute('title', 'Project settings');
      await expect(strip.locator('button button')).toHaveCount(0);
      await expect(strip).toHaveCSS('border-radius', '0px');
      await expect(strip).toHaveCSS('font-size', '14px');
      await expect(summary.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
      const contributionOnly = item.key === 'contributor' || item.key === 'changed-contributor';
      await expect(strip).toHaveCSS(
        'background-color',
        contributionOnly ? 'rgba(0, 0, 0, 0)' : SUMMARY_ACCENT[item.tone],
      );
      const iconColor = contributionOnly ? SUMMARY_ACCENT[item.tone] : 'rgb(0, 0, 0)';
      await expect(strip.locator('.project-summary-settings-icon path')).toHaveCSS('fill', iconColor);
      if (contributionOnly) {
        await expect(strip).toHaveCSS('color', SUMMARY_ACCENT[item.tone]);
        await expect(summary).toHaveCSS('box-shadow', `${SUMMARY_ACCENT[item.tone]} 0px 0px 0px 1px inset`);
        await expect(summary.locator('.active-project-status-line')).toHaveCount(0);
        expect((await strip.boundingBox())!.height).toBe(30);
      }
      if (item.refs) {
        await expect(summary.locator('.publication-reference-link')).toHaveText('3 referenced projects');
        expect((await strip.boundingBox())!.height).toBeGreaterThan(30);
      } else await expect(summary.locator('.publication-reference-link')).toHaveCount(0);
    }
    await openProjectContextMenu(page, local.name);
    await expect(summary.locator('.project-summary-route-badge')).toHaveText(['API', 'APP']);
    await expect(summary.locator('.project-summary-route-text')).toHaveText([
      `workflows/${local.settings.endpointName}`,
      'apps/live-app',
    ]);
    await summary.locator('.project-summary-settings-strip').click({ position: { x: 3, y: 3 } });
    const settings = page.getByTestId('workflow-project-settings-modal');
    await expect(settings.locator('.project-settings-modal-title')).toHaveText('local');
    await settings.getByRole('button', { name: 'Close project settings' }).click();
    await openProjectContextMenu(page, local.name);
    await summary.locator('.project-summary-settings-icon').click();
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Close project settings' }).click();
    await openProjectContextMenu(page, 'Summary references');
    await summary.getByRole('button', { name: '3 referenced projects', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'Changes in referenced projects', exact: true });
    await expect(details).toBeVisible();
    await expect(settings).toHaveCount(0);
    await expect(summary).toHaveCount(0);
    await details.getByRole('button', { name: 'Close reference details' }).click();
    await openProjectContextMenu(page, 'Summary references');
    await summary.getByRole('button', { name: 'Settings', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(summary.getByRole('button', { name: '3 referenced projects', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(details).toBeVisible();
    await expect(settings).toHaveCount(0);
    await details.getByRole('button', { name: 'Close reference details' }).click();
    await expect(page.getByTestId('workflow-reference-details-modal')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Expand folders pane', exact: true })).toBeVisible();
  });

  test('shows project details in the context menu with publication fills and no outline', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    projects[1]!.settings.publishedEndpointName = 'currently-serving-endpoint';
    projects[1]!.settings.endpointName = 'draft-endpoint-name';
    projects[2]!.settings.endpointAccess = 'internal';
    await installStatusDotTreeRoute(page, projects);
    await page.route('**/api/config', (route) =>
      route.fulfill({
        json: {
          executorWsUrl: '',
          remoteDebuggerDefaultWs: '',
          publishedWorkflowsBasePath: '/custom/workflows/',
          internalPublishedWorkflowsBaseUrl: 'http://execution.test/internal/workflows/',
          latestWorkflowsBasePath: '/workflows-latest',
          publishedAppsBasePath: '/apps',
          latestAppsBasePath: '/apps-latest',
          webAppsAuthMode: 'none',
        },
      }),
    );
    await page.addInitScript(() => {
      const copied: string[] = [];
      Object.assign(window, { copiedEndpointUrls: copied });
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            copied.push(text);
          },
        },
        configurable: true,
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');

    await expect(activeProjectSection).toHaveCount(0);
    await expect(page.locator('.active-project-slot')).toHaveCount(0);

    for (const project of projects) {
      await openProjectContextMenu(page, project.name);
      await expect(activeProjectSection).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(activeProjectSection).toHaveCSS('border-width', '0px');
      await expect(activeProjectSection).toHaveCSS('padding', '0px');
      await expect(activeProjectSection.locator('.active-project-stats')).toHaveCount(0);
      if (project.settings.status === 'unpublished') {
        await expect(activeProjectSection.locator('.active-project-status-list')).toHaveCount(0);
      } else {
        const badge = activeProjectSection.locator('.project-summary-settings-strip');
        await expect(badge).toHaveCSS('background-color', SUMMARY_ACCENT[project.settings.status]);
        await expect(badge).toHaveCSS('border-width', '0px');
        await expect(badge).toHaveCSS('color', 'rgb(0, 0, 0)');
        await expect(activeProjectSection.locator(':scope > :first-child')).toHaveClass(
          /project-summary-settings-strip/,
        );
        const statusGap = await activeProjectSection.evaluate((section) => {
          const status = section.querySelector('.project-summary-settings-strip')!.getBoundingClientRect();
          const name = section.querySelector('.active-project-name-row')!.getBoundingClientRect();
          return name.top - status.bottom;
        });
        expect(statusGap).toBeCloseTo(14);
        await expect(
          activeProjectSection.locator('.active-project-endpoint-name .project-summary-route-text'),
        ).toHaveText(
          project.settings.endpointAccess === 'internal'
            ? `http://execution.test/internal/workflows/${project.settings.endpointName}`
            : `custom/workflows/${project.settings.publishedEndpointName}`,
        );
        await activeProjectSection.getByTitle('Copy full endpoint URL').click();
        const expectedUrl =
          project.settings.endpointAccess === 'internal'
            ? `http://execution.test/internal/workflows/${project.settings.endpointName}`
            : new URL(`/custom/workflows/${project.settings.publishedEndpointName}`, page.url()).href;
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { copiedEndpointUrls: string[] }).copiedEndpointUrls.at(-1)),
          )
          .toBe(expectedUrl);
        await expect(
          page.getByRole('alert').filter({ hasText: 'Endpoint URL copied to clipboard' }).first(),
        ).toBeVisible();
        await expect(activeProjectSection).toBeVisible();
        const line = activeProjectSection.locator('.active-project-status-line').first();
        const labelBox = (await line.locator('.project-summary-route-badge').boundingBox())!;
        const linkBox = (await line.locator('.project-summary-route-text').boundingBox())!;
        expect(Math.abs(labelBox.y - linkBox.y)).toBeLessThan(3);
      }
      await expect(activeProjectSection).toHaveCSS(
        'background-color',
        ACTIVE_PROJECT_BACKGROUND[project.settings.status],
      );
    }
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error('Clipboard denied');
      };
      document.execCommand = () => false;
    });
    await activeProjectSection.getByTitle('Copy full endpoint URL').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not copy endpoint URL.' })).toBeVisible();
    await activeProjectSection.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByTestId('workflow-project-settings-modal');
    await expect(modal.locator('.project-settings-modal-title')).toHaveText(projects.at(-1)!.name);
    await expect(page.getByRole('menu', { name: `Actions for ${projects.at(-1)!.name}` })).toHaveCount(0);
  });

  test('anchors the edge-to-edge project summary above the cursor as details resize', async ({ page }) => {
    const projects = Array.from({ length: 12 }, (_, index) => {
      const project = createStatusProject('unpublished');
      project.name = `${String(index).padStart(2, '0')} menu positioning`;
      project.id = project.name;
      project.fileName = `${project.name}.rivet-project`;
      project.relativePath = project.fileName;
      project.absolutePath = `/managed/workflows/${project.fileName}`;
      return project;
    });
    const project = projects[8]!;
    project.settings.status = 'published';
    project.settings.endpointName = 'positioned-endpoint';
    project.stats = { graphCount: 2, totalNodeCount: 4, webAppCount: 2 };
    project.settings.publishedWebApps = [
      {
        uiGraphId: 'first',
        uiGraphName: 'First app',
        slug: 'first',
        publishedAt: '2026-05-15T09:00:00.000Z',
        allowedEmails: [],
      },
    ];
    await installStatusDotTreeRoute(page, projects);
    const releaseApps = Promise.withResolvers<void>();
    await page.route('**/api/workflows/projects/web-apps**', async (route) => {
      await releaseApps.promise;
      await route.fulfill({
        json: createProjectWebAppsResponse({
          ...project,
          webApps: ['first', 'second'].map((id) => ({
            uiGraphId: id,
            name: `${id} published web app`,
            publishedSlug: id,
            publishedAt: '2026-05-15T09:00:00.000Z',
            allowedEmails: [],
            status: 'published',
            isMissingFromProject: false,
          })),
        }),
      });
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const row = page.getByRole('button', { name: project.name, exact: true });
    const rowBox = (await row.boundingBox())!;
    const point = { x: rowBox.x + rowBox.width - 2, y: rowBox.y + rowBox.height / 2 };
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = page.getByRole('menu', { name: `Actions for ${project.name}` });
    const header = menu.locator('.workflow-project-context-menu-header');
    const summary = menu.locator('.active-project-section');
    const expectAnchor = async () => {
      await expect
        .poll(async () => {
          const box = (await summary.boundingBox())!;
          return Math.max(Math.abs(box.x - point.x), Math.abs(box.y + box.height - point.y));
        })
        .toBeLessThan(1.5);
    };
    try {
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS('padding', '0px');
      await expect(header).toHaveCSS('border-bottom-width', '0px');
      await expect(header).toHaveCSS('margin-bottom', '0px');
      await expect(header).toHaveCSS('padding-bottom', '0px');
      await expect(summary).toHaveCSS('border-radius', '0px');
      await expect(
        menu.locator('.workflow-project-context-menu-header + .workflow-project-context-menu-actions'),
      ).toHaveCount(1);
      const fillGap = await menu.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const content = element.querySelector('.active-project-section')!.getBoundingClientRect();
        return Math.max(
          Math.abs(content.left - box.left - element.clientLeft),
          Math.abs(content.top - box.top - element.clientTop),
          Math.abs(content.width - element.clientWidth),
        );
      });
      expect(fillGap).toBeLessThan(1);
      await expectAnchor();
      const initialHeight = (await summary.boundingBox())!.height;
      releaseApps.resolve();
      await expect(summary.getByRole('link')).toHaveCount(2);
      expect((await summary.boundingBox())!.height).toBeGreaterThan(initialHeight);
      await expectAnchor();
      await page.setViewportSize({ width: 390, height: 420 });
      await expect
        .poll(async () => {
          const box = (await menu.boundingBox())!;
          return box.x >= 7.5 && box.y >= 7.5 && box.x + box.width <= 382.5 && box.y + box.height <= 412.5;
        })
        .toBe(true);
      await menu.getByRole('menuitem', { name: 'Delete project', exact: true }).scrollIntoViewIfNeeded();
      await expect(menu.getByRole('menuitem', { name: 'Delete project', exact: true })).toBeVisible();
    } finally {
      releaseApps.resolve();
    }
  });

  for (const [outcome, description] of [
    ['success', 'remains visible after removing its draft graph'],
    ['failure', 'reports unavailable on read failure'],
    ['replacement', 'rejects a replacement project at the same path'],
  ] as const) {
    test(`retained web-app publication ${description}`, async ({ page }) => {
      const project = createStatusProject('unpublished');
      project.projectMetadataId = 'retained-owner';
      project.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 0 };
      // Older responses omit the aggregate field; tree metadata still knows
      // that this app remains published with unpublished draft changes.
      delete project.settings.publicationStatus;
      project.settings.publishedWebApps = [
        {
          uiGraphId: 'removed-app',
          uiGraphName: 'Still live app',
          slug: 'still-live-app',
          allowedEmails: [],
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'unpublished_changes',
        },
      ];
      await installStatusDotTreeRoute(page, [project]);
      await page.route('**/api/workflows/projects/web-apps**', (route) =>
        route.fulfill({
          status: outcome === 'failure' ? 503 : 200,
          json:
            outcome === 'failure'
              ? { error: 'Status read unavailable' }
              : createProjectWebAppsResponse({
                  ...project,
                  projectMetadataId: outcome === 'replacement' ? 'replacement-owner' : project.projectMetadataId,
                  webApps: [
                    {
                      uiGraphId: 'removed-app',
                      name: 'Still live app',
                      publishedSlug: 'still-live-app',
                      publishedAt: '2026-05-15T09:00:00.000Z',
                      allowedEmails: [],
                      status: 'unpublished_changes',
                      isMissingFromProject: true,
                    },
                  ],
                }),
        }),
      );
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await openProjectContextMenu(page, project.name);
      const lines = page.locator('.active-project-section .active-project-status-line');
      await expect(page.locator('.active-project-section')).toHaveClass(/\bunpublished_changes\b/);
      await expect(lines).toHaveCount(1);
      await expect(lines.first()).toContainText('APP');
      await expect(lines.first()).toContainText(outcome === 'success' ? 'apps/still-live-app' : 'Unavailable');
      await expect(lines.first()).not.toContainText('none');
      await expect(page.locator('.project-summary-status-text')).toHaveText('Unpublished changes');
      if (outcome === 'success')
        await expect(
          page.locator('.active-project-section').getByRole('link', { name: 'Still live app' }),
        ).toHaveAttribute('href', '/apps/still-live-app');
      else await expect(page.locator('.active-project-section').getByRole('link')).toHaveCount(0);
    });
  }

  test('summary refreshes web app links for each saved revision and ignores superseded reads', async ({ page }) => {
    const project = createStatusProject('unpublished');
    project.projectMetadataId = 'summary-project';
    project.revisionId = 'revision-1';
    project.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 1 };
    project.settings.publishedWebApps = [
      {
        uiGraphId: 'portal',
        uiGraphName: 'Portal',
        slug: 'portal',
        publishedAt: '2026-05-15T09:00:00.000Z',
        allowedEmails: [],
        status: 'unpublished_changes',
      },
    ];
    await installStatusDotTreeRoute(page, [project]);
    const reads: string[] = [];
    const releaseSecond = Promise.withResolvers<void>();
    const secondFulfilled = Promise.withResolvers<void>();
    await page.route('**/api/workflows/projects/web-apps**', async (route) => {
      const snapshot = structuredClone(project);
      reads.push(snapshot.revisionId!);
      if (snapshot.revisionId === 'revision-2') await releaseSecond.promise;
      await route.fulfill({
        json: createProjectWebAppsResponse({
          ...snapshot,
          webApps: [
            {
              uiGraphId: 'portal',
              name: `Portal ${snapshot.revisionId}`,
              publishedSlug: 'portal',
              publishedAt: '2026-05-15T09:00:00.000Z',
              allowedEmails: [],
              status: 'unpublished_changes',
              isMissingFromProject: false,
            },
          ],
        }),
      });
      if (snapshot.revisionId === 'revision-2') secondFulfilled.resolve();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await openProjectContextMenu(page, project.name);
    const summary = page.locator('.active-project-section');
    await expect(summary.getByRole('link', { name: 'Portal revision-1' })).toBeVisible();

    const saveRevision = async (revision: string) => {
      project.revisionId = revision;
      project.name = `Summary ${revision}`;
      await page.evaluate((path) => {
        const editor = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame')!;
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'project-saved', path },
            origin: location.origin,
            source: editor.contentWindow,
          }),
        );
      }, project.absolutePath);
      await expect(summary.locator('.active-project-name')).toHaveText(project.name);
    };
    try {
      // Identity, timestamps and publication tokens stay the same: only the saved revision advances.
      await saveRevision('revision-2');
      await expect.poll(() => reads).toContain('revision-2');
      await expect(summary.getByRole('link')).toHaveCount(0);
      await saveRevision('revision-3');
      await expect(summary.getByRole('link', { name: 'Portal revision-3' })).toBeVisible();
      const lateResponse = page.waitForResponse(
        async (response) =>
          response.url().includes('/api/workflows/projects/web-apps') &&
          ((await response.json()) as { draftRevisionId?: string }).draftRevisionId === 'revision-2',
      );
      releaseSecond.resolve();
      await (await lateResponse).finished();
      await secondFulfilled.promise;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await expect(summary.getByRole('link')).toHaveAccessibleName('Portal revision-3');
      expect(reads).toEqual(['revision-1', 'revision-2', 'revision-3']);
    } finally {
      releaseSecond.resolve();
    }
  });

  test('shows publication status before endpoint and live web app links in the project menu header', async ({
    page,
  }) => {
    const noAppsProject = createStatusProject('unpublished');
    noAppsProject.name = 'codex-summary-no-apps';
    noAppsProject.fileName = 'codex-summary-no-apps.rivet-project';
    noAppsProject.relativePath = 'codex-summary-no-apps.rivet-project';
    noAppsProject.absolutePath = '/managed/workflows/codex-summary-no-apps.rivet-project';
    noAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 0 };

    const oneAppProject = createStatusProject('unpublished');
    oneAppProject.name = 'codex-summary-one-app';
    oneAppProject.fileName = 'codex-summary-one-app.rivet-project';
    oneAppProject.relativePath = 'codex-summary-one-app.rivet-project';
    oneAppProject.absolutePath = '/managed/workflows/codex-summary-one-app.rivet-project';
    oneAppProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 1 };
    oneAppProject.settings.publicationStatus = 'published';

    const sameStatusAppsProject = createStatusProject('published');
    sameStatusAppsProject.name = 'codex-summary-same-apps';
    sameStatusAppsProject.fileName = 'codex-summary-same-apps.rivet-project';
    sameStatusAppsProject.relativePath = 'codex-summary-same-apps.rivet-project';
    sameStatusAppsProject.absolutePath = '/managed/workflows/codex-summary-same-apps.rivet-project';
    sameStatusAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 3 };
    sameStatusAppsProject.settings.publicationStatus = 'unpublished_changes';

    const mixedStatusAppsProject = createStatusProject('unpublished_changes');
    mixedStatusAppsProject.name = 'codex-summary-mixed-apps';
    mixedStatusAppsProject.fileName = 'codex-summary-mixed-apps.rivet-project';
    mixedStatusAppsProject.relativePath = 'codex-summary-mixed-apps.rivet-project';
    mixedStatusAppsProject.absolutePath = '/managed/workflows/codex-summary-mixed-apps.rivet-project';
    mixedStatusAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 2 };

    await installStatusDotTreeRoute(page, [
      noAppsProject,
      oneAppProject,
      sameStatusAppsProject,
      mixedStatusAppsProject,
    ]);
    await installProjectWebAppsRoute(page, [oneAppProject, sameStatusAppsProject, mixedStatusAppsProject], {
      [oneAppProject.relativePath]: [
        {
          uiGraphId: 'one-app',
          name: 'One App',
          publishedSlug: 'one app',
          publishedAt: '2026-05-15T09:00:00.000Z',
          allowedEmails: [],
          status: 'published',
          isMissingFromProject: false,
        },
      ],
      [sameStatusAppsProject.relativePath]: [
        {
          uiGraphId: 'same-app-a',
          name: 'Same App A',
          publishedSlug: 'same-app-a',
          publishedAt: '2026-05-15T09:00:00.000Z',
          allowedEmails: [],
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'same-app-b',
          name: 'Same App B',
          publishedSlug: 'same-app-b',
          publishedAt: '2026-05-15T09:00:00.000Z',
          allowedEmails: [],
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'draft-only-app',
          name: 'Draft only',
          publishedSlug: null,
          publishedAt: null,
          allowedEmails: [],
          status: 'unpublished',
          isMissingFromProject: false,
        },
      ],
      [mixedStatusAppsProject.relativePath]: [
        {
          uiGraphId: 'mixed-app-a',
          name: 'Mixed App A',
          publishedSlug: 'mixed-app-a',
          publishedAt: '2026-05-15T09:00:00.000Z',
          allowedEmails: [],
          status: 'published',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'mixed-app-b',
          name: 'Mixed App B',
          publishedSlug: 'mixed-app-b',
          publishedAt: '2026-05-15T09:00:00.000Z',
          allowedEmails: [],
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
      ],
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');
    const statusLines = activeProjectSection.locator('.active-project-status-line');

    await expect(
      page.getByRole('button', { name: noAppsProject.name, exact: true }).locator('.project-status-dot'),
    ).toBeHidden();
    await expect(
      page.getByRole('button', { name: oneAppProject.name, exact: true }).locator('.project-status-dot'),
    ).toHaveClass(/\bpublished\b/);
    await expect(
      page.getByRole('button', { name: sameStatusAppsProject.name, exact: true }).locator('.project-status-dot'),
    ).toHaveClass(/\bunpublished_changes\b/);

    await openProjectContextMenu(page, noAppsProject.name);
    await expect(activeProjectSection.locator('.active-project-details > :first-child')).toHaveClass(
      /active-project-name-row/,
    );
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(noAppsProject.name);
    await expect(statusLines).toHaveCount(0);
    await expect(activeProjectSection).not.toContainText('Web app:');
    await expect(activeProjectSection).not.toContainText('Endpoint:');
    await expect(activeProjectSection.locator('.active-project-actions-row')).toHaveCount(0);

    await openProjectContextMenu(page, oneAppProject.name);
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(oneAppProject.name);
    await expect(activeProjectSection).toHaveClass(/\bpublished\b/);
    await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND.published);
    await expect(statusLines).toHaveCount(1);
    await expect(statusLines.first()).toContainText('APP');
    await expect(activeProjectSection.locator('.project-summary-status-text')).toHaveText('Published');
    const appLink = activeProjectSection.getByRole('link', { name: 'One App', exact: true });
    await expect(appLink).toHaveAttribute('href', '/apps/one%20app');
    await expect(appLink).toHaveAttribute('rel', 'noopener noreferrer');
    await page
      .context()
      .route('**/apps/one%20app', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>One App</h1>' }));
    const popupPromise = page.waitForEvent('popup');
    await appLink.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new URL('/apps/one%20app', page.url()).href);
    await expect(popup.getByRole('heading', { name: 'One App' })).toBeVisible();
    await expect(activeProjectSection).toHaveCount(0);
    await popup.close();
    await expect(page.locator('.workflow-library-panel')).toBeVisible();

    await openProjectContextMenu(page, sameStatusAppsProject.name);
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(sameStatusAppsProject.name);
    await expect(activeProjectSection).toHaveClass(/\bunpublished_changes\b/);
    await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND.unpublished_changes);
    await expect(statusLines).toHaveCount(3);
    await expect(statusLines.first().locator('.project-summary-route-text')).toHaveText(
      `workflows/${sameStatusAppsProject.settings.endpointName}`,
    );
    await expect(activeProjectSection.getByRole('link').locator('.project-summary-route-text')).toHaveText([
      'apps/same-app-a',
      'apps/same-app-b',
    ]);
    await expect(activeProjectSection.locator('.project-summary-status-text')).toHaveText('Unpublished changes');
    await expect(activeProjectSection).not.toContainText('Draft only');

    await openProjectContextMenu(page, mixedStatusAppsProject.name);
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(mixedStatusAppsProject.name);
    await expect(statusLines).toHaveCount(3);
    await expect(activeProjectSection.getByRole('link').locator('.project-summary-route-text')).toHaveText([
      'apps/mixed-app-a',
      'apps/mixed-app-b',
    ]);
    await expect(activeProjectSection.locator('.project-summary-status-text')).toHaveText('Unpublished changes');
  });
});
