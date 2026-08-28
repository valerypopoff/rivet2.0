import { expect, test, type Page } from '@playwright/test';
import type {
  WorkflowProjectItem,
  WorkflowProjectStatus,
  WorkflowProjectWebAppSummary,
} from '../../studio-server-shared/workflow-types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const STATUS_DOT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgb(187, 187, 187)',
  published: 'rgb(126, 226, 148)',
  unpublished_changes: 'rgb(255, 215, 106)',
};

const ACTIVE_PROJECT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgba(255, 255, 255, 0.07)',
  published: 'rgba(126, 226, 148, 0.12)',
  unpublished_changes: 'rgba(255, 215, 106, 0.12)',
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
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        root: '/managed/workflows',
        folders: [],
        projects,
      }),
    });
  });
}

async function installProjectWebAppsRoute(
  page: Page,
  webAppsByRelativePath: Record<string, WorkflowProjectWebAppSummary[]>,
): Promise<void> {
  await page.route('**/api/workflows/projects/web-apps**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/workflows/projects/web-apps') {
      await route.fallback();
      return;
    }

    const relativePath = url.searchParams.get('relativePath') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
  let deploymentStorageSettings = {
    storageMode: 'filesystem',
    artifactsHostPath: '../',
    databaseMode: 'local-docker',
    databaseSslMode: 'disable',
    databaseConnectionStringConfigured: false,
    storageUrl: '',
    storageAccessKeyId: '',
    storageAccessKeyConfigured: false,
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
  let trustedHostSettings = {
    trustedHosts: ['internal.example.test'],
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
        remoteDebuggerDefaultWs: executorUrlOverrideSettings.remoteDebuggerDefaultWs || 'ws://127.0.0.1:8081/ws/latest-debugger',
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
          const normalized = String(value || fallback).trim().replace(/^\/+/, '').replace(/\/+$/, '');
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
          webAppActionRequestLimitBytes: Number(body.webAppActionRequestLimitBytes ?? runtimeLimitSettings.webAppActionRequestLimitBytes),
          dockerWaitTimeoutSeconds: Number(body.dockerWaitTimeoutSeconds ?? runtimeLimitSettings.dockerWaitTimeoutSeconds),
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

    if (url.pathname === '/api/app-settings/trusted-hosts') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as {
          trustedHosts?: string[];
        };
        trustedHostSettings = {
          trustedHosts: body.trustedHosts ?? [],
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(trustedHostSettings),
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
        body: JSON.stringify(trustedHostSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/deployment-storage') {
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        deploymentStorageSettings = {
          storageMode: String(body.storageMode ?? deploymentStorageSettings.storageMode),
          artifactsHostPath: String(body.artifactsHostPath ?? deploymentStorageSettings.artifactsHostPath),
          databaseMode: String(body.databaseMode ?? deploymentStorageSettings.databaseMode),
          databaseSslMode: String(body.databaseSslMode ?? deploymentStorageSettings.databaseSslMode),
          databaseConnectionStringConfigured: Boolean(body.databaseConnectionString) || deploymentStorageSettings.databaseConnectionStringConfigured,
          storageUrl: String(body.storageUrl ?? deploymentStorageSettings.storageUrl),
          storageAccessKeyId: String(body.storageAccessKeyId ?? deploymentStorageSettings.storageAccessKeyId),
          storageAccessKeyConfigured: Boolean(body.storageAccessKey) || deploymentStorageSettings.storageAccessKeyConfigured,
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(deploymentStorageSettings),
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

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'project-opened', path: projectPath },
      origin: window.location.origin,
      source: editorFrame?.contentWindow ?? null,
    }));
  }, path);
}

test.describe('Workflow library layout', () => {
  test('collapses from the full header row into a clickable narrow rail', async ({ page }) => {
    await installAppSettingsRoute(page);

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

    await expect(page.getByRole('button', { name: 'App settings' })).toBeVisible();
    await page.getByRole('button', { name: 'App settings' }).click();
    const appSettingsModal = page.locator('[data-testid="app-settings-modal"]');
    await expect(appSettingsModal).toBeVisible();
    const appSettingsActions = appSettingsModal.locator('.app-settings-panel-region > .app-settings-actions-row');
    await expect(appSettingsModal.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    const appSettingsTabList = appSettingsModal.getByRole('tablist', { name: 'App settings sections' });
    await expect(appSettingsTabList).toHaveAttribute('aria-orientation', 'vertical');
    const [generalTabBox, storageTabBox, panelRegionBox] = await Promise.all([
      appSettingsModal.getByRole('tab', { name: 'General' }).boundingBox(),
      appSettingsModal.getByRole('tab', { name: 'Storage' }).boundingBox(),
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
    await expect(appSettingsModal.getByLabel('Trusted hosts')).toHaveValue('internal.example.test');
    await appSettingsModal.getByLabel('Trusted hosts').fill('internal.example.test\nhealthcheck.example.test');
    await appSettingsActions.getByRole('button', { name: 'Revert' }).click();
    await expect(appSettingsModal.getByLabel('Trusted hosts')).toHaveValue('internal.example.test');
    await appSettingsModal.getByLabel('Trusted hosts').fill('internal.example.test\nhealthcheck.example.test');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Trusted hosts')).toHaveValue('internal.example.test\nhealthcheck.example.test');

    await appSettingsModal.getByRole('tab', { name: 'Shell execution' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Shell execution' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.getByText('They do not limit workflows, web apps, LLM calls, HTTP Call nodes, or endpoints.')).toBeVisible();
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

    await appSettingsModal.getByRole('tab', { name: 'Workflow endpoints' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Workflow endpoints' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-section-title')).toContainText(['Routes', 'Access control', 'HTTP request timeout']);
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveValue('workflows');
    await expect(appSettingsModal.getByLabel('Latest saved workflow endpoint URL slug')).toHaveValue('workflows-latest');
    await expect(appSettingsModal.getByLabel('Require Authorization: Bearer <Rivet key> for workflow endpoint calls')).toBeChecked();
    await expect(appSettingsModal.getByLabel('Proxy read timeout in seconds')).toHaveValue('180');
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveCount(0);
    await appSettingsModal.getByLabel('Published workflow endpoint URL slug').fill('public-workflows');
    await appSettingsModal.getByLabel('Require Authorization: Bearer <Rivet key> for workflow endpoint calls').uncheck();
    await appSettingsModal.getByLabel('Proxy read timeout in seconds').fill('240');
    await expect(appSettingsActions).toHaveCount(1);
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveValue('public-workflows');
    await expect(appSettingsModal.getByLabel('Require Authorization: Bearer <Rivet key> for workflow endpoint calls')).not.toBeChecked();
    await expect.poll(async () => {
      const [contentBox, sectionBox] = await Promise.all([
        appSettingsModal.locator('.app-settings-panel-region').boundingBox(),
        appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-section').first().boundingBox(),
      ]);
      return contentBox && sectionBox ? sectionBox.width / contentBox.width : 0;
    }).toBeGreaterThan(0.9);

    await appSettingsModal.getByRole('tab', { name: 'Storage' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-section-title')).toHaveCount(0);
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-section')).toHaveCount(2);
    await expect(appSettingsModal.getByRole('button', { name: 'Local folders' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByRole('button', { name: 'Object storage' })).toHaveAttribute('aria-pressed', 'false');
    await expect(appSettingsModal.getByLabel('Host artifacts folder')).toHaveValue('../');
    await expect(appSettingsModal.getByLabel('Host artifacts folder')).toHaveAttribute('readonly', '');
    await expect(appSettingsModal.getByText('The running app shows it for reference only because changing it here cannot remount host folders.')).toBeVisible();
    const storageFieldGrids = appSettingsModal.locator('.app-settings-storage-panel .app-settings-field-grid');
    await expect(storageFieldGrids.first()).toHaveCSS('gap', '18px');
    await expect(storageFieldGrids.nth(1)).toHaveCSS('gap', '18px');
    await appSettingsModal.getByRole('button', { name: 'Object storage' }).click();
    await expect(appSettingsModal.getByRole('button', { name: 'Local Docker Postgres' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByText('It must already be running before object storage mode can apply.')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Object storage URL')).toHaveValue('');
    await expect(appSettingsModal.getByLabel('Object storage access key ID')).toHaveValue('');
    await appSettingsModal.getByLabel('Object storage URL').fill('http://workflow-minio:9000/rivet-workflows');
    await appSettingsModal.getByLabel('Object storage access key ID').fill('minioadmin');
    await appSettingsModal.getByLabel('Object storage secret access key').fill('minioadmin');
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('min-width', '84px');
    await expect(appSettingsActions).toHaveCSS('border-top-width', '1px');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved. Restart Docker services or roll out Kubernetes pods to apply storage changes.');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-section > .project-settings-success')).toHaveCount(0);

    await appSettingsModal.getByRole('tab', { name: 'Run recordings' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Run recordings' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section-title')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Queued recording writes')).toHaveValue('100');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep latest runs' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep all runs' })).toHaveAttribute('aria-pressed', 'false');
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveValue('2000');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep forever' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep for some time' })).toHaveAttribute('aria-pressed', 'false');
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveCount(0);
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-field-grid')).toHaveCSS('gap', '18px');
    await expect(appSettingsModal.getByText('Keeping only the newest runs for each endpoint. Older runs are removed during cleanup.')).toBeVisible();
    await expect(appSettingsModal.getByText('Recordings are kept indefinitely unless another saved limit removes them.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Keep all runs' }).click();
    await expect(appSettingsModal.getByText('Keeping every recorded run for each endpoint.')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveCount(0);
    await appSettingsModal.getByRole('button', { name: 'Keep latest runs' }).click();
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveValue('2000');
    await appSettingsModal.getByRole('button', { name: 'Keep for some time' }).click();
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveValue('14');
    await expect(appSettingsModal.getByText('Recordings older than the selected number of days are removed during cleanup.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Keep forever' }).click();
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveCount(0);
    await expect.poll(async () => {
      const [contentBox, sectionBox] = await Promise.all([
        appSettingsModal.locator('.app-settings-panel-region').boundingBox(),
        appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section').boundingBox(),
      ]);
      return contentBox && sectionBox ? sectionBox.width / contentBox.width : 0;
    }).toBeGreaterThan(0.9);
    await appSettingsModal.getByLabel('Queued recording writes').fill('101');
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsActions.locator('.app-settings-action-button').first()).toHaveCSS('min-width', '84px');
    await expect(appSettingsActions).toHaveCSS('border-top-width', '1px');
    await expect(appSettingsActions).toHaveCSS('margin-top', '8px');
    await expect(appSettingsActions).toHaveCSS('padding-top', '14px');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section > .project-settings-success')).toHaveCount(0);
    await appSettingsModal.getByRole('tab', { name: 'Node executor proxy' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Node executor proxy' })).toHaveAttribute('aria-selected', 'true');
    const websocketOverrideSection = appSettingsModal.locator('.app-settings-proxy-panel .app-settings-section', { hasText: 'Websocket URL overrides' });
    await expect(websocketOverrideSection.locator('.app-settings-section-title')).toHaveText('Websocket URL overrides');
    await expect(appSettingsModal.getByText('HTTP_PROXY')).toBeVisible();
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-section').first().locator('.app-settings-field-grid')).toHaveCSS('gap', '18px');
    await expect(appSettingsActions).toHaveCount(1);
    await expect(appSettingsModal.getByRole('textbox', { name: 'HTTP_PROXY' })).toHaveValue('http://proxy.example.internal:3128');
    await expect(appSettingsModal.getByText('NO_PROXY')).toBeVisible();
    await expect(appSettingsModal.getByRole('textbox', { name: 'NO_PROXY' })).toHaveValue('localhost,127.0.0.1,::1,api,web,executor,proxy,.svc,.cluster.local');
    await expect(appSettingsModal.getByText('In Kubernetes, include cluster-local suffixes such as .svc and .cluster.local')).toBeVisible();
    await expect(appSettingsModal.getByText('Websocket URL overrides')).toBeVisible();
    await expect(appSettingsModal.getByRole('textbox', { name: 'Node executor websocket URL override' })).toHaveValue('');
    await expect(appSettingsModal.getByRole('textbox', { name: 'Remote Debugger websocket URL override' })).toHaveValue('');
    await expect(appSettingsModal.getByText('Active URL: ws://127.0.0.1:8081/ws/executor/internal.')).toBeVisible();
    await appSettingsModal.getByRole('textbox', { name: 'HTTP_PROXY' }).fill('http://proxy.example.internal:3129');
    await appSettingsModal
      .getByRole('textbox', { name: 'Remote Debugger websocket URL override' })
      .fill('wss://debugger.example.test/ws/latest-debugger');
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved. Reload the editor to apply websocket URL overrides to active sessions.');
    await expect(appSettingsModal.getByText('Active URL: wss://debugger.example.test/ws/latest-debugger.')).toBeVisible();

    await appSettingsModal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Web apps' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-section-title')).toContainText(['Routes', 'Auth', 'Button data']);
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveValue('apps');
    await expect(appSettingsModal.getByLabel('Maximum web app button data in MiB')).toHaveValue('100');
    await expect(appSettingsModal.getByLabel('Latest saved changes URL slug')).toHaveValue('apps-latest');
    const appRouteRow = appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-prefixed-input-row').first();
    await expect(appRouteRow).toHaveCSS('display', 'flex');
    await expect.poll(async () => {
      const [prefixBox, inputBox] = await Promise.all([
        appRouteRow.locator('.project-settings-url-prefix').boundingBox(),
        appRouteRow.locator('.project-settings-input').boundingBox(),
      ]);
      return prefixBox && inputBox
        ? Math.max(Math.abs(prefixBox.y - inputBox.y), Math.abs(prefixBox.height - inputBox.height))
        : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    await appSettingsModal.getByLabel('Published web app URL slug').fill('public-apps');
    await expect(appSettingsModal.getByRole('button', { name: 'Key' })).toHaveAttribute('aria-pressed', 'true');
    const webAppAuthMode = appSettingsModal.getByRole('group', { name: 'Web app auth mode' });
    await expect(webAppAuthMode).toHaveClass(/segmented-control/);
    await expect(webAppAuthMode.getByRole('button', { name: 'Key' })).toHaveCSS('height', '28px');
    await expect(appSettingsModal.getByText('Visitors enter the Rivet key before opening web apps.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'OAuth' }).click();
    await expect(appSettingsModal.getByText("Visitors sign in with the provider configured in the OAuth tab and are checked against each web app's allowed-email list.")).toBeVisible();

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
    await expect(appSettingsModal.locator('.app-settings-oauth-panel .app-settings-section-title')).toHaveText('Provider');
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
    await expect.poll(async () => {
      const tabsAfterPanelScroll = await settingsTabList.boundingBox();
      return tabsBeforePanelScroll && tabsAfterPanelScroll
        ? Math.abs(tabsAfterPanelScroll.y - tabsBeforePanelScroll.y)
        : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    await settingsPanelRegion.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(appSettingsModal.getByRole('button', { name: 'External provider' })).toHaveAttribute('aria-pressed', 'true');
    await appSettingsModal.getByRole('button', { name: 'Local dummy' }).click();
    await expect(appSettingsModal.getByText('Default test email')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Default test email')).toHaveValue('local@example.test');
    await appSettingsModal.getByLabel('Session signing secret').fill('local-session-secret');
    await expect(appSettingsActions).toHaveCount(1);
    await appSettingsActions.getByRole('button', { name: 'Save' }).click();
    await expect(appSettingsActions.locator('.project-settings-success')).toHaveText('Saved.');

    await appSettingsModal.getByRole('tab', { name: 'Server UI access' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Server UI access' })).toHaveAttribute('aria-selected', 'true');
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
    const dockerTimeoutInput = appSettingsModal.getByRole('spinbutton', { name: 'Docker startup wait timeout in seconds' });
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
    expect(Math.abs((expandIconBox!.y + expandIconBox!.height / 2) - (sidebarBox!.y + sidebarBox!.height / 2))).toBeLessThan(2);

    await page.mouse.click(sidebarBox!.x + sidebarBox!.width / 2, sidebarBox!.y + sidebarBox!.height - 20);

    const titleVisibilityDuringExpand = await title.evaluate((element) => window.getComputedStyle(element).visibility);
    expect(titleVisibilityDuringExpand).toBe('hidden');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
    await expect(page.getByRole('button', { name: 'Collapse folders pane' })).toBeVisible();
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Rivet Projects');
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
    expect(Math.abs((statusDotBox!.x + statusDotBox!.width / 2) - (sidebarBox!.x + sidebarBox!.width / 2))).toBeLessThan(2);
    expect(Math.abs((statusDotBox!.y + statusDotBox!.height / 2) - (sidebarBox!.y + 18.5))).toBeLessThan(2);
  });

  test('tints the active project summary by publication status', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    await installStatusDotTreeRoute(page, projects);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');

    for (const project of projects) {
      await page.getByRole('button', { name: project.name, exact: true }).click();
      await expect(activeProjectSection).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND[project.settings.status]);
    }
  });

  test('shows workflow and web app publication status lines in the active project summary', async ({ page }) => {
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
    sameStatusAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 2 };
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
    await installProjectWebAppsRoute(page, {
      [oneAppProject.relativePath]: [
        {
          uiGraphId: 'one-app',
          name: 'One App',
          publishedSlug: 'one-app',
          publishedAt: '2026-05-15T09:00:00.000Z',
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
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'same-app-b',
          name: 'Same App B',
          publishedSlug: 'same-app-b',
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
      ],
      [mixedStatusAppsProject.relativePath]: [
        {
          uiGraphId: 'mixed-app-a',
          name: 'Mixed App A',
          publishedSlug: 'mixed-app-a',
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'published',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'mixed-app-b',
          name: 'Mixed App B',
          publishedSlug: null,
          publishedAt: null,
          status: 'unpublished',
          isMissingFromProject: false,
        },
      ],
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSlot = page.locator('.workflow-library-panel .active-project-slot');
    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');
    const statusLines = activeProjectSection.locator('.active-project-status-line');

    await expect(activeProjectSlot).toHaveCSS('height', '166px');
    await expect(activeProjectSection).toHaveCSS('height', '166px');
    await expect(page.getByRole('button', { name: noAppsProject.name, exact: true }).locator('.project-status-dot')).toBeHidden();
    await expect(page.getByRole('button', { name: oneAppProject.name, exact: true }).locator('.project-status-dot')).toHaveClass(/\bpublished\b/);
    await expect(page.getByRole('button', { name: sameStatusAppsProject.name, exact: true }).locator('.project-status-dot')).toHaveClass(/\bunpublished_changes\b/);

    await page.getByRole('button', { name: noAppsProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-details > :first-child')).toHaveClass(/active-project-name-row/);
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(noAppsProject.name);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.first()).toContainText('Endpoint:');
    await expect(statusLines.first().locator('.project-status-badge')).toHaveText('Unpublished');
    await expect(statusLines.nth(1)).toContainText('Web app:');
    await expect(statusLines.nth(1).locator('.active-project-status-text')).toHaveText('none');
    await expect(statusLines.first()).toHaveCSS('height', '22px');
    await expect(statusLines.nth(1)).toHaveCSS('height', '22px');
    await expect(statusLines.nth(1).locator('.active-project-status-text')).toHaveCSS('height', '22px');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes');
    await expect(activeProjectSection.locator('.active-project-actions-row')).toHaveCSS('margin-top', '8px');

    await page.getByRole('button', { name: oneAppProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(oneAppProject.name);
    await expect(activeProjectSection).toHaveClass(/\bpublished\b/);
    await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND.published);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.first().locator('.project-status-badge')).toHaveText('Unpublished');
    await expect(statusLines.nth(1)).toContainText('Web app:');
    await expect(statusLines.nth(1).locator('.project-status-badge')).toHaveText('Published');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes, 1 web app');

    await page.getByRole('button', { name: sameStatusAppsProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(sameStatusAppsProject.name);
    await expect(activeProjectSection).toHaveClass(/\bunpublished_changes\b/);
    await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND.unpublished_changes);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.first().locator('.project-status-badge')).toHaveText('Published');
    await expect(statusLines.nth(1)).toContainText('Web apps:');
    await expect(statusLines.nth(1).locator('.project-status-badge')).toHaveText('Unpublished changes');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes, 2 web apps');

    await page.getByRole('button', { name: mixedStatusAppsProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(mixedStatusAppsProject.name);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.nth(1)).toContainText('Web apps:');
    await expect(statusLines.nth(1).locator('.active-project-various-statuses')).toHaveText('various statuses');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes, 2 web apps');
    await expect(activeProjectSlot).toHaveCSS('height', '166px');
    await expect(activeProjectSection).toHaveCSS('height', '166px');
  });
});
