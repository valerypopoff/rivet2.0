import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';

import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../auth.js';
import { readWebAppAuthSettingsSync, writeWebAppAuthSettings } from '../web-app-auth-settings.js';
import { readJson, withEnvOverride } from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import {
  createWebAppProject,
  createWebAppProjectWithUiGraphs,
  extractWebAppRevisionKey,
  serializeWebAppProject,
  WEB_APP_TEST_ACTION_COMPONENT_ID,
  WEB_APP_TEST_UI_GRAPH_ID,
} from './helpers/workflow-web-app-fixtures.js';

const {
  workflowMutations,
  workflowStorageBackend,
  workflowFs,
  rivetNode,
  withWorkflowApiServer,
  withWorkflowExecutionServer,
  resetAndEnsureWorkflowsRoot,
  cleanupWorkflowSuite,
} = await createFilesystemWorkflowSuiteHarness();

test.beforeEach(resetAndEnsureWorkflowsRoot);
test.after(cleanupWorkflowSuite);

async function withEnvOverrides(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const entries = Object.entries(values);
  const apply = async (index: number): Promise<void> => {
    if (index >= entries.length) {
      await run();
      return;
    }

    const [name, value] = entries[index]!;
    await withEnvOverride(name, value, () => apply(index + 1));
  };

  await apply(0);
}

async function withWebAppAuthSettings(
  settings: Parameters<typeof writeWebAppAuthSettings>[0],
  run: () => Promise<void>,
): Promise<void> {
  await writeWebAppAuthSettings(settings);
  try {
    await run();
  } finally {
    await writeWebAppAuthSettings({ mode: 'ui-gate' });
  }
}

async function writeWebAppProject(projectPath: string, projectName: string, appName: string): Promise<void> {
  const blankProjectContents = workflowFs.createBlankProjectFile(projectName);
  const project = createWebAppProject(rivetNode, blankProjectContents, appName);
  const serializedProject = serializeWebAppProject(rivetNode, project);

  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

async function writeBrokenActionWebAppProject(projectPath: string, projectName: string, appName: string): Promise<void> {
  const blankProjectContents = workflowFs.createBlankProjectFile(projectName);
  const project = createWebAppProject(rivetNode, blankProjectContents, appName);
  const button = project.uiGraphs?.[WEB_APP_TEST_UI_GRAPH_ID]?.components[0] as { action?: { graphId?: unknown } } | undefined;
  if (button?.action) {
    button.action.graphId = 'missing-action-graph';
  }
  const serializedProject = serializeWebAppProject(rivetNode, project);

  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

async function writeWebAppHeadersContextProject(projectPath: string, projectName: string, appName: string): Promise<void> {
  const blankProjectContents = workflowFs.createBlankProjectFile(projectName);
  const project = createWebAppProject(rivetNode, blankProjectContents, appName);
  const graph = project.graphs[project.metadata.mainGraphId!];

  graph.nodes = [
    {
      type: 'context',
      title: 'Context',
      id: 'context-headers',
      visualData: { x: 0, y: 0, width: 300 },
      data: {
        id: 'headers',
        dataType: 'any',
        defaultValue: undefined,
        useDefaultValueInput: false,
      },
    } as never,
    {
      type: 'graphOutput',
      title: 'Graph Output',
      id: 'graph-output',
      visualData: { x: 360, y: 0, width: 300 },
      data: {
        id: 'value',
        dataType: 'any',
      },
    } as never,
  ];
  graph.connections = [
    {
      outputNodeId: 'context-headers',
      outputId: 'data',
      inputNodeId: 'graph-output',
      inputId: 'value',
    } as never,
  ];

  const serializedProject = serializeWebAppProject(rivetNode, project);

  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

async function writeMultiWebAppProject(projectPath: string, projectName: string, appNames: Array<[string, string]>): Promise<void> {
  const blankProjectContents = workflowFs.createBlankProjectFile(projectName);
  const project = createWebAppProjectWithUiGraphs(rivetNode, blankProjectContents, appNames);
  const serializedProject = serializeWebAppProject(rivetNode, project);

  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

async function publishWebApp(relativePath: string, slug: string): Promise<void> {
  await workflowStorageBackend.publishWorkflowProjectWebAppsWithBackend(relativePath, [{
    uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
    slug,
  }]);
}

function createSignedOAuthSessionCookie(email: string, secret: string): string {
  const settings = readWebAppAuthSettingsSync();
  const clientSecretFingerprint = settings.clientSecret
    ? createHmac('sha256', secret).update(settings.clientSecret).digest('base64url')
    : '';
  const settingsVersion = createHmac('sha256', secret)
    .update(JSON.stringify({
      mode: settings.mode,
      provider: settings.provider,
      dummyEmail: settings.dummyEmail,
      dummyAllowNonLocalhost: settings.dummyAllowNonLocalhost,
      authorizeUrl: settings.authorizeUrl,
      tokenUrl: settings.tokenUrl,
      userUrl: settings.userUrl,
      clientId: settings.clientId,
      clientSecretFingerprint,
      callbackUrl: settings.callbackUrl,
      scopes: settings.scopes,
      emailClaim: settings.emailClaim,
      sessionTtlSeconds: settings.sessionTtlSeconds,
      clientAuthMethod: settings.clientAuthMethod,
    }))
    .digest('base64url');
  const payload = Buffer.from(JSON.stringify({
    email,
    expiresAt: Date.now() + 60_000,
    settingsVersion,
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `rivet_web_app_oauth_session=${payload}.${signature}`;
}

function decodeSignedPayload(value: string): Record<string, unknown> {
  const payload = value.split('.')[0] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

test('workflow web app publication routes publish multiple project web apps independently', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'MultiPublishedWebApp');
  await writeMultiWebAppProject(created.absolutePath, 'MultiPublishedWebApp', [
    ['ui-one', 'First Web App'],
    ['ui-two', 'Second Web App'],
  ]);

  await withWorkflowApiServer(async (baseUrl) => {
    const initialList = await readJson<{
      webApps: Array<{ uiGraphId: string; name: string; publishedSlug: string | null; status: string }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));

    assert.deepEqual(
      initialList.webApps.map((webApp) => [webApp.uiGraphId, webApp.name, webApp.publishedSlug, webApp.status]),
      [
        ['ui-one', 'First Web App', null, 'unpublished'],
        ['ui-two', 'Second Web App', null, 'unpublished'],
      ],
    );

    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        publications: [
          { uiGraphId: 'ui-one', slug: 'first-app' },
          { uiGraphId: 'ui-two', slug: 'second-app' },
        ],
      }),
    }));

    const publishedList = await readJson<{
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null; status: string }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(
      publishedList.webApps.map((webApp) => [webApp.uiGraphId, webApp.publishedSlug, webApp.status]),
      [
        ['ui-one', 'first-app', 'published'],
        ['ui-two', 'second-app', 'published'],
      ],
    );

    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        uiGraphId: 'ui-one',
      }),
    }));

    const afterUnpublishList = await readJson<{
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null; status: string }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(
      afterUnpublishList.webApps.map((webApp) => [webApp.uiGraphId, webApp.publishedSlug, webApp.status]),
      [
        ['ui-one', null, 'unpublished'],
        ['ui-two', 'second-app', 'published'],
      ],
    );
  });

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const firstResponse = await fetch(`${webAppsBaseUrl}/first-app`, {
      signal: AbortSignal.timeout(5000),
    });
    const secondResponse = await fetch(`${webAppsBaseUrl}/second-app`, {
      signal: AbortSignal.timeout(5000),
    });

    assert.equal(firstResponse.status, 404);
    assert.equal(secondResponse.status, 200);
    assert.match(await secondResponse.text(), /Second Web App/);
  });
});

test('workflow web app publication stores and updates OAuth allowed emails without republishing', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'WebAppAllowedEmails');
  await writeWebAppProject(created.absolutePath, 'WebAppAllowedEmails', 'Allowed Emails Web App');

  await withWorkflowApiServer(async (baseUrl) => {
    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        publications: [
          {
            uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
            slug: 'allowed-emails-web-app',
            allowedEmails: ['USER@example.com', 'admin@example.com', 'user@example.com'],
          },
        ],
      }),
    }));

    const publishedList = await readJson<{
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null; allowedEmails: string[] }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(publishedList.webApps.map((webApp) => [
      webApp.uiGraphId,
      webApp.publishedSlug,
      webApp.allowedEmails,
    ]), [[WEB_APP_TEST_UI_GRAPH_ID, 'allowed-emails-web-app', ['user@example.com', 'admin@example.com']]]);

    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        accessUpdates: [
          {
            uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
            allowedEmails: ['owner@example.com'],
          },
        ],
      }),
    }));

    const updatedList = await readJson<{
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null; allowedEmails: string[] }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(updatedList.webApps.map((webApp) => [
      webApp.uiGraphId,
      webApp.publishedSlug,
      webApp.allowedEmails,
    ]), [[WEB_APP_TEST_UI_GRAPH_ID, 'allowed-emails-web-app', ['owner@example.com']]]);
  });
});

test('workflow web app publication routes allow batch slug swaps for selected apps', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'SwappedWebApps');
  await writeMultiWebAppProject(created.absolutePath, 'SwappedWebApps', [
    ['ui-one', 'First Web App'],
    ['ui-two', 'Second Web App'],
  ]);

  await withWorkflowApiServer(async (baseUrl) => {
    for (const publications of [
      [
        { uiGraphId: 'ui-one', slug: 'swap-first-app' },
        { uiGraphId: 'ui-two', slug: 'swap-second-app' },
      ],
      [
        { uiGraphId: 'ui-one', slug: 'swap-second-app' },
        { uiGraphId: 'ui-two', slug: 'swap-first-app' },
      ],
    ]) {
      await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          relativePath: created.relativePath,
          publications,
        }),
      }));
    }

    const publishedList = await readJson<{
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null; status: string }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(
      publishedList.webApps.map((webApp) => [webApp.uiGraphId, webApp.publishedSlug, webApp.status]),
      [
        ['ui-one', 'swap-second-app', 'published'],
        ['ui-two', 'swap-first-app', 'published'],
      ],
    );
  });
});

test('workflow web app publication status tracks saved draft changes and republish', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'WebAppPublicationStatus');
  await writeWebAppProject(created.absolutePath, 'WebAppPublicationStatus', 'Published Status Web App');
  await publishWebApp(created.relativePath, 'web-app-publication-status');

  await withWorkflowApiServer(async (baseUrl) => {
    const readTreePublicationStatus = async () => {
      const tree = await workflowStorageBackend.getWorkflowTree();
      return tree.projects.find((project) => project.relativePath === created.relativePath)?.settings.publicationStatus;
    };
    const readStatus = async () => {
      const response = await readJson<{
        webApps: Array<{ uiGraphId: string; publishedSlug: string | null; status: string }>;
      }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));

      const webApp = response.webApps.find((candidate) => candidate.uiGraphId === WEB_APP_TEST_UI_GRAPH_ID);
      return webApp
        ? {
          uiGraphId: webApp.uiGraphId,
          publishedSlug: webApp.publishedSlug,
          status: webApp.status,
        }
        : null;
    };

    assert.deepEqual(await readStatus(), {
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      publishedSlug: 'web-app-publication-status',
      status: 'published',
    });
    assert.equal(await readTreePublicationStatus(), 'published');

    const datasetPath = workflowFs.getWorkflowDatasetPath(created.absolutePath);
    await fs.writeFile(datasetPath, 'dataset: changed\n', 'utf8');
    assert.deepEqual(await readStatus(), {
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      publishedSlug: 'web-app-publication-status',
      status: 'unpublished_changes',
    });
    assert.equal(await readTreePublicationStatus(), 'unpublished_changes');

    await fs.rm(datasetPath);
    assert.deepEqual(await readStatus(), {
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      publishedSlug: 'web-app-publication-status',
      status: 'published',
    });
    assert.equal(await readTreePublicationStatus(), 'published');

    await writeWebAppProject(created.absolutePath, 'WebAppPublicationStatus', 'Changed Status Web App');
    assert.deepEqual(await readStatus(), {
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      publishedSlug: 'web-app-publication-status',
      status: 'unpublished_changes',
    });
    assert.equal(await readTreePublicationStatus(), 'unpublished_changes');

    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        publications: [
          { uiGraphId: WEB_APP_TEST_UI_GRAPH_ID, slug: 'web-app-publication-status' },
        ],
      }),
    }));

    assert.deepEqual(await readStatus(), {
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      publishedSlug: 'web-app-publication-status',
      status: 'published',
    });
    assert.equal(await readTreePublicationStatus(), 'published');
  });
});

test('published workflow web apps block project deletion until unpublished', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'DeleteWebAppPublishedProject');
  await writeWebAppProject(created.absolutePath, 'DeleteWebAppPublishedProject', 'Delete Guard Web App');
  await publishWebApp(created.relativePath, 'delete-guard-web-app');

  await assert.rejects(
    () => workflowMutations.deleteWorkflowProjectItem(created.relativePath),
    /Unpublish the workflow endpoint and web apps before deleting the project/,
  );

  await workflowStorageBackend.unpublishWorkflowProjectWebAppWithBackend(
    created.relativePath,
    WEB_APP_TEST_UI_GRAPH_ID,
  );
  await workflowMutations.deleteWorkflowProjectItem(created.relativePath);

  assert.equal(await workflowFs.pathExists(created.absolutePath), false);
});

test('workflow web app publication routes keep stale published apps visible for unpublish', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'StalePublishedWebApp');
  await writeWebAppProject(created.absolutePath, 'StalePublishedWebApp', 'Legacy Web App');
  await publishWebApp(created.relativePath, 'legacy-web-app');
  await writeMultiWebAppProject(created.absolutePath, 'StalePublishedWebApp', []);

  await withWorkflowApiServer(async (baseUrl) => {
    const staleList = await readJson<{
      webApps: Array<{
        uiGraphId: string;
        name: string;
        publishedSlug: string | null;
        status: string;
        isMissingFromProject: boolean;
      }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));

    assert.deepEqual(
      staleList.webApps.map((webApp) => [
        webApp.uiGraphId,
        webApp.name,
        webApp.publishedSlug,
        webApp.status,
        webApp.isMissingFromProject,
      ]),
      [[WEB_APP_TEST_UI_GRAPH_ID, 'Legacy Web App', 'legacy-web-app', 'unpublished_changes', true]],
    );

    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      }),
    }));

    const afterUnpublishList = await readJson<{
      webApps: Array<{ uiGraphId: string }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(afterUnpublishList.webApps, []);
  });
});

test('published filesystem web apps serve HTML and app JSON from the published snapshot', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebApp');
  await writeWebAppProject(created.absolutePath, 'PublishedWebApp', 'Published Web App');
  await publishWebApp(created.relativePath, 'published-web-app');
  await writeWebAppProject(created.absolutePath, 'PublishedWebApp', 'Draft Web App');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const htmlResponse = await fetch(`${webAppsBaseUrl}/published-web-app`, {
      signal: AbortSignal.timeout(5000),
    });
    const html = await htmlResponse.text();

    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html, /Published Web App/);
    assert.doesNotMatch(html, /Draft Web App/);
    assert.match(html, /\/apps\/published-web-app\/actions\/run/);
    assert.match(html, /"revisionKey":"filesystem-web-app:/);

    const appJsonResponse = await fetch(`${webAppsBaseUrl}/published-web-app/app.json`, {
      signal: AbortSignal.timeout(5000),
    });
    const appJson = await appJsonResponse.json() as { name?: string };

    assert.equal(appJsonResponse.status, 200);
    assert.equal(appJson.name, 'Published Web App');
  });
});

test('latest filesystem web apps serve the saved draft for a published web app slug', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LatestWebApp');
  await writeWebAppProject(created.absolutePath, 'LatestWebApp', 'Published Latest Web App');
  await publishWebApp(created.relativePath, 'latest-web-app');
  await writeWebAppProject(created.absolutePath, 'LatestWebApp', 'Draft Latest Web App');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl, latestWebAppsBaseUrl }) => {
    const publishedHtmlResponse = await fetch(`${webAppsBaseUrl}/latest-web-app`, {
      signal: AbortSignal.timeout(5000),
    });
    const publishedHtml = await publishedHtmlResponse.text();

    assert.equal(publishedHtmlResponse.status, 200);
    assert.match(publishedHtml, /Published Latest Web App/);
    assert.doesNotMatch(publishedHtml, /Draft Latest Web App/);
    assert.match(publishedHtml, /\/apps\/latest-web-app\/actions\/run/);

    const latestHtmlResponse = await fetch(`${latestWebAppsBaseUrl}/latest-web-app`, {
      signal: AbortSignal.timeout(5000),
    });
    const latestHtml = await latestHtmlResponse.text();

    assert.equal(latestHtmlResponse.status, 200);
    assert.match(latestHtml, /Draft Latest Web App/);
    assert.doesNotMatch(latestHtml, /Published Latest Web App/);
    assert.match(latestHtml, /\/apps-latest\/latest-web-app\/actions\/run/);

    const latestAppJsonResponse = await fetch(`${latestWebAppsBaseUrl}/latest-web-app/app.json`, {
      signal: AbortSignal.timeout(5000),
    });
    const latestAppJson = await latestAppJsonResponse.json() as { name?: string };

    assert.equal(latestAppJsonResponse.status, 200);
    assert.equal(latestAppJson.name, 'Draft Latest Web App');
  });
});

test('latest filesystem web app actions reject stale saved-draft revisions', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'LatestWebAppRevision');
  await writeWebAppProject(created.absolutePath, 'LatestWebAppRevision', 'Initial Draft Web App');
  await publishWebApp(created.relativePath, 'latest-web-app-revision');

  await withWorkflowExecutionServer(async ({ latestWebAppsBaseUrl }) => {
    const oldHtml = await (await fetch(`${latestWebAppsBaseUrl}/latest-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const oldRevisionKey = extractWebAppRevisionKey(oldHtml);

    await writeWebAppProject(created.absolutePath, 'LatestWebAppRevision', 'Changed Draft Web App With New Text');

    const nextHtml = await (await fetch(`${latestWebAppsBaseUrl}/latest-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const nextRevisionKey = extractWebAppRevisionKey(nextHtml);
    assert.notEqual(nextRevisionKey, oldRevisionKey);

    const staleActionResponse = await fetch(`${latestWebAppsBaseUrl}/latest-web-app-revision/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
        revisionKey: oldRevisionKey,
        state: {
          prompt: 'stale latest',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const staleBody = await staleActionResponse.json() as { code?: string; error?: string };

    assert.equal(staleActionResponse.status, 409);
    assert.equal(staleBody.error, 'Rivet web app revision mismatch.');
    assert.equal(staleBody.code, 'revision_mismatch');
  });
});

test('published filesystem web apps use the UI gate instead of workflow bearer auth', async () => {
  await withEnvOverride('RIVET_REQUIRE_WORKFLOW_KEY', 'false', async () => {
    await withEnvOverride('RIVET_REQUIRE_UI_GATE_KEY', 'true', async () => {
      await withEnvOverride('RIVET_KEY', 'web-app-ui-session-key', async () => {
        const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppUiSession');
        await writeWebAppProject(created.absolutePath, 'PublishedWebAppUiSession', 'Published UI Session App');
        await publishWebApp(created.relativePath, 'published-web-app-ui-session');

        await withWorkflowExecutionServer(async ({ publishedBaseUrl, webAppsBaseUrl, latestWebAppsBaseUrl }) => {
          const unauthenticatedResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session`, {
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(unauthenticatedResponse.status, 401);

          const latestUnauthenticatedResponse = await fetch(`${latestWebAppsBaseUrl}/published-web-app-ui-session`, {
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(latestUnauthenticatedResponse.status, 401);

          const uiSessionHeaders = {
            Cookie: `rivet_ui_token=${getExpectedUiSessionToken()}`,
            'X-Rivet-Proxy-Auth': getExpectedProxyAuthToken(),
          };
          const htmlResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session`, {
            headers: uiSessionHeaders,
            signal: AbortSignal.timeout(5000),
          });
          const html = await htmlResponse.text();

          assert.equal(htmlResponse.status, 200);
          assert.match(html, /Published UI Session App/);
          const revisionKey = extractWebAppRevisionKey(html);

          const appJsonResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session/app.json`, {
            headers: uiSessionHeaders,
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(appJsonResponse.status, 200);

          const crossOriginAppJsonResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session/app.json`, {
            headers: {
              ...uiSessionHeaders,
              Origin: 'https://evil.example.test',
            },
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(crossOriginAppJsonResponse.status, 403);
          const crossOriginAppJsonBody = await crossOriginAppJsonResponse.json() as { error?: string; code?: string };
          assert.equal(crossOriginAppJsonBody.error, 'Cross-origin web app request denied');
          assert.equal(crossOriginAppJsonBody.code, 'origin_forbidden');

          const actionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session/actions/run`, {
            method: 'POST',
            headers: {
              ...uiSessionHeaders,
              'Content-Type': 'application/json',
              Origin: new URL(webAppsBaseUrl).origin,
            },
            body: JSON.stringify({
              componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
              revisionKey,
              state: {
                prompt: 'hello with ui session',
              },
            }),
            signal: AbortSignal.timeout(5000),
          });
          const actionBody = await actionResponse.json() as {
            statePatch?: Record<string, unknown>;
          };

          assert.equal(actionResponse.status, 200);
          assert.deepEqual(actionBody.statePatch, { result: 'hello with ui session' });

          const tokenFreeResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session/app.json`, {
            headers: {
              'X-Rivet-Proxy-Auth': getExpectedProxyAuthToken(),
              'X-Rivet-Token-Free-Host': '1',
            },
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(tokenFreeResponse.status, 200);

          const latestTokenFreeResponse = await fetch(`${latestWebAppsBaseUrl}/published-web-app-ui-session/app.json`, {
            headers: {
              'X-Rivet-Proxy-Auth': getExpectedProxyAuthToken(),
              'X-Rivet-Token-Free-Host': '1',
            },
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(latestTokenFreeResponse.status, 200);

          await withEnvOverride('RIVET_REQUIRE_WORKFLOW_KEY', 'true', async () => {
            const workflowResponse = await fetch(`${publishedBaseUrl}/missing-workflow`, {
              method: 'POST',
              headers: uiSessionHeaders,
              body: '{}',
              signal: AbortSignal.timeout(5000),
            });
            assert.equal(workflowResponse.status, 401);
          });
        });
      });
    });
  });
});

test('published filesystem web apps can use OAuth instead of the UI key gate', async () => {
  await withWebAppAuthSettings({
    mode: 'oauth',
    provider: 'external',
    authorizeUrl: 'https://oauth.example.test/authorize',
    tokenUrl: 'https://oauth.example.test/token',
    userUrl: 'https://oauth.example.test/profile',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: 'https://rivet.example.test/apps/auth/callback',
    sessionSecret: 'session-secret',
  }, async () => {
    await withEnvOverrides({
      RIVET_REQUIRE_UI_GATE_KEY: 'true',
    }, async () => {
    const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppOAuth');
    await writeWebAppProject(created.absolutePath, 'PublishedWebAppOAuth', 'Published OAuth App');
    await workflowStorageBackend.publishWorkflowProjectWebAppsWithBackend(created.relativePath, [{
      uiGraphId: WEB_APP_TEST_UI_GRAPH_ID,
      slug: 'published-web-app-oauth',
      allowedEmails: ['user@example.com'],
    }]);

    await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
      const allowedSessionCookie = createSignedOAuthSessionCookie('user@example.com', 'session-secret');
      const deniedSessionCookie = createSignedOAuthSessionCookie('other@example.com', 'session-secret');
      const htmlResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(htmlResponse.status, 401);
      assert.match(htmlResponse.headers.get('cache-control') ?? '', /no-store/);
      const loginRequiredHtml = await htmlResponse.text();
      assert.match(loginRequiredHtml, /Sign in required/);
      assert.match(loginRequiredHtml, /Sign in to open this Rivet web app/);
      assert.match(loginRequiredHtml, /href="\/apps\/published-web-app-oauth\?auth_action=login"/);

      const loginRedirectResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth?auth_action=login`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(loginRedirectResponse.status, 302);
      assert.match(loginRedirectResponse.headers.get('cache-control') ?? '', /no-store/);
      const loginLocation = loginRedirectResponse.headers.get('location') ?? '';
      assert.match(loginLocation, /^https:\/\/oauth\.example\.test\/authorize\?/);
      assert.match(loginRedirectResponse.headers.get('set-cookie') ?? '', /rivet_web_app_oauth_state=/);
      const loginState = new URL(loginLocation).searchParams.get('state') ?? '';
      assert.equal(decodeSignedPayload(loginState).returnTo, '/apps/published-web-app-oauth');

      const authErrorResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth?auth_error=oauth_profile`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(authErrorResponse.status, 401);
      const authErrorHtml = await authErrorResponse.text();
      assert.match(authErrorHtml, /Web app sign-in failed/);
      assert.match(authErrorHtml, /profile response did not include the configured email claim/);
      assert.match(authErrorHtml, /href="\/apps\/published-web-app-oauth"/);

      const mixedAuthErrorResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth?auth_action=login&auth_error=oauth_profile`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(mixedAuthErrorResponse.status, 401);
      const mixedAuthErrorHtml = await mixedAuthErrorResponse.text();
      assert.match(mixedAuthErrorHtml, /Web app sign-in failed/);
      assert.doesNotMatch(mixedAuthErrorHtml, /oauth\.example\.test\/authorize/);

      const crossOriginHtmlResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth`, {
        headers: { Origin: 'https://evil.example.test' },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(crossOriginHtmlResponse.status, 403);
      const crossOriginHtml = await crossOriginHtmlResponse.text();
      assert.match(crossOriginHtml, /Web app request blocked/);
      assert.match(crossOriginHtml, /origin_forbidden/);
      assert.match(crossOriginHtml, /Sign out/);

      const deniedResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth`, {
        headers: { cookie: deniedSessionCookie },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(deniedResponse.status, 403);
      assert.match(deniedResponse.headers.get('cache-control') ?? '', /no-store/);
      const deniedHtml = await deniedResponse.text();
      assert.match(deniedHtml, /Web app access denied/);
      assert.match(deniedHtml, /other@example\.com/);
      assert.match(deniedHtml, /Sign out and choose another account/);
      assert.match(deniedHtml, /href="\/apps\/auth\/logout\?return_to=%2Fapps%2Fpublished-web-app-oauth"/);

      const allowedResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth`, {
        headers: { cookie: allowedSessionCookie },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(allowedResponse.status, 200);
      const allowedHtml = await allowedResponse.text();
      assert.match(allowedHtml, /rivet-web-app-auth-logout/);
      assert.match(allowedHtml, /href="\/apps\/auth\/logout\?return_to=%2Fapps%2Fpublished-web-app-oauth"/);

      const crossOriginActionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth/actions/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example.test',
          'X-Forwarded-Host': 'evil.example.test',
          'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({
          componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
          state: {},
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(crossOriginActionResponse.status, 403);
      const crossOriginActionBody = await crossOriginActionResponse.json() as { error?: string; code?: string };
      assert.equal(crossOriginActionBody.error, 'Cross-origin web app request denied');
      assert.equal(crossOriginActionBody.code, 'origin_forbidden');

      const actionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-oauth/actions/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: new URL(webAppsBaseUrl).origin,
        },
        body: JSON.stringify({
          componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
          state: {},
        }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(actionResponse.status, 401);
      const actionBody = await actionResponse.json() as { error?: string; code?: string };
      assert.equal(actionBody.error, 'OAuth login required');
      assert.equal(actionBody.code, 'oauth_required');
    });
    });
  });
});

test('workflow web app publication rejects the reserved OAuth auth slug', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'ReservedAuthWebApp');
  await writeWebAppProject(created.absolutePath, 'ReservedAuthWebApp', 'Reserved Auth Web App');

  await withWorkflowApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/projects/web-apps/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        publications: [
          { uiGraphId: WEB_APP_TEST_UI_GRAPH_ID, slug: 'auth' },
        ],
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? '', /reserved/);
  });
});

test('published filesystem web app actions run through the wrapper execution dependencies', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppAction');
  await writeWebAppProject(created.absolutePath, 'PublishedWebAppAction', 'Published Action App');
  await publishWebApp(created.relativePath, 'published-web-app-action');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const html = await (await fetch(`${webAppsBaseUrl}/published-web-app-action`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const revisionKey = extractWebAppRevisionKey(html);
    const actionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-action/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
        revisionKey,
        state: {
          prompt: 'hello from web app',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const actionBody = await actionResponse.json() as {
      outputs?: Record<string, unknown>;
      statePatch?: Record<string, unknown>;
    };

    assert.equal(actionResponse.status, 200);
    assert.deepEqual(actionBody.outputs?.value, { type: 'string', value: 'hello from web app' });
    assert.deepEqual(actionBody.statePatch, { result: 'hello from web app' });
  });
});

test('published filesystem web app actions do not expose browser auth headers to graph context', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppHeaderContext');
  await writeWebAppHeadersContextProject(
    created.absolutePath,
    'PublishedWebAppHeaderContext',
    'Published Header Context App',
  );
  await publishWebApp(created.relativePath, 'published-web-app-header-context');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const html = await (await fetch(`${webAppsBaseUrl}/published-web-app-header-context`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const revisionKey = extractWebAppRevisionKey(html);
    const actionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-header-context/actions/run`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer browser-secret',
        Cookie: 'rivet_web_app_oauth_session=session-secret; rivet_ui_token=ui-secret',
        'Content-Type': 'application/json',
        'X-Rivet-Proxy-Auth': 'proxy-secret',
        'X-Rivet-Token-Free-Host': '1',
        'X-Storyteller-Header': 'safe-request-header',
      },
      body: JSON.stringify({
        componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
        revisionKey,
        state: {},
      }),
      signal: AbortSignal.timeout(5000),
    });
    const actionBody = await actionResponse.json() as {
      outputs?: {
        value?: {
          value?: Record<string, unknown>;
        };
      };
    };

    assert.equal(actionResponse.status, 200);
    const contextHeaders = actionBody.outputs?.value?.value ?? {};
    assert.equal(contextHeaders['x-storyteller-header'], 'safe-request-header');
    assert.equal(contextHeaders['content-type'], 'application/json');
    assert.equal(Object.prototype.hasOwnProperty.call(contextHeaders, 'authorization'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(contextHeaders, 'cookie'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(contextHeaders, 'x-rivet-proxy-auth'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(contextHeaders, 'x-rivet-token-free-host'), false);
  });
});

test('published filesystem web app actions reject malformed action metadata', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppBadAction');
  await writeWebAppProject(created.absolutePath, 'PublishedWebAppBadAction', 'Published Bad Action App');
  await publishWebApp(created.relativePath, 'published-web-app-bad-action');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const response = await fetch(`${webAppsBaseUrl}/published-web-app-bad-action/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: 123,
        state: {},
      }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json() as { code?: string; error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid componentId.');
    assert.equal(body.code, undefined);
  });
});

test('published filesystem web app actions hide unexpected internal errors', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppInternalError');
  await writeBrokenActionWebAppProject(created.absolutePath, 'PublishedWebAppInternalError', 'Published Internal Error App');
  await publishWebApp(created.relativePath, 'published-web-app-internal-error');

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
      const html = await (await fetch(`${webAppsBaseUrl}/published-web-app-internal-error`, {
        signal: AbortSignal.timeout(5000),
      })).text();
      const revisionKey = extractWebAppRevisionKey(html);
      const response = await fetch(`${webAppsBaseUrl}/published-web-app-internal-error/actions/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
          revisionKey,
          state: { prompt: 'do not leak details' },
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json() as { code?: string; error?: string };

      assert.equal(response.status, 500);
      assert.equal(body.error, 'Internal server error');
      assert.equal(body.code, undefined);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('published filesystem web app actions reject stale published revisions', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppRevision');
  await writeWebAppProject(created.absolutePath, 'PublishedWebAppRevision', 'Published Revision App');
  await publishWebApp(created.relativePath, 'published-web-app-revision');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const oldHtml = await (await fetch(`${webAppsBaseUrl}/published-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const oldRevisionKey = extractWebAppRevisionKey(oldHtml);

    await writeWebAppProject(created.absolutePath, 'PublishedWebAppRevision', 'Republished Revision App');
    await publishWebApp(created.relativePath, 'published-web-app-revision');

    const nextHtml = await (await fetch(`${webAppsBaseUrl}/published-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const nextRevisionKey = extractWebAppRevisionKey(nextHtml);
    assert.notEqual(nextRevisionKey, oldRevisionKey);

    const staleActionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-revision/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
        revisionKey: oldRevisionKey,
        state: {
          prompt: 'stale',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const staleBody = await staleActionResponse.json() as { code?: string; error?: string };

    assert.equal(staleActionResponse.status, 409);
    assert.equal(staleBody.error, 'Rivet web app revision mismatch.');
    assert.equal(staleBody.code, 'revision_mismatch');
  });
});
