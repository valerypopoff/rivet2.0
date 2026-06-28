import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import type { GraphId, NodeGraph, Project, UiGraphId } from '@valerypopoff/rivet2-node';

import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../auth.js';
import { readJson, withEnvOverride } from './helpers/workflow-api-harness.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';

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

function createWebAppProject(projectName: string, appName: string): Project {
  return createWebAppProjectWithUiGraphs(projectName, [['ui-graph', appName]]);
}

function createWebAppProjectWithUiGraphs(projectName: string, uiGraphs: Array<[string, string]>): Project {
  const project = rivetNode.loadProjectFromString(workflowFs.createBlankProjectFile(projectName));
  const graphId = project.metadata.mainGraphId as GraphId;
  const graph: NodeGraph = {
    metadata: {
      description: '',
      id: graphId,
      name: 'Main Graph',
    },
    nodes: [
      {
        type: 'graphInput',
        title: 'Input',
        id: 'input-node',
        visualData: { x: 0, y: 0, width: 300 },
        data: {
          id: 'input',
          dataType: 'string',
        },
      } as never,
      {
        type: 'graphOutput',
        title: 'Output',
        id: 'output-node',
        visualData: { x: 360, y: 0, width: 300 },
        data: {
          id: 'value',
          dataType: 'string',
        },
      } as never,
    ],
    connections: [
      {
        outputNodeId: 'input-node',
        outputId: 'data',
        inputNodeId: 'output-node',
        inputId: 'value',
      } as never,
    ],
  };

  project.graphs[graphId] = graph;
  project.uiGraphs = Object.fromEntries(uiGraphs.map(([uiGraphId, appName]) => [
    uiGraphId as UiGraphId,
    {
      id: uiGraphId as UiGraphId,
      name: appName,
      components: [
        {
          id: 'run-button' as never,
          type: 'button',
          label: 'Run',
          action: {
            type: 'runGraph',
            graphId,
            inputs: {
              input: { type: 'state', key: 'prompt' },
            },
            outputKey: 'value',
            outputStateKey: 'result',
          },
        },
      ],
    },
  ])) as Project['uiGraphs'];

  return project;
}

async function writeWebAppProject(projectPath: string, projectName: string, appName: string): Promise<void> {
  const serializedProject = rivetNode.serializeProject(createWebAppProject(projectName, appName));
  if (typeof serializedProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }

  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

async function writeMultiWebAppProject(projectPath: string, projectName: string, appNames: Array<[string, string]>): Promise<void> {
  const serializedProject = rivetNode.serializeProject(createWebAppProjectWithUiGraphs(projectName, appNames));
  if (typeof serializedProject !== 'string') {
    throw new TypeError('Expected serialized project to be a string');
  }

  await fs.writeFile(projectPath, serializedProject, 'utf8');
}

async function publishWebApp(relativePath: string, slug: string): Promise<void> {
  await workflowStorageBackend.publishWorkflowProjectWebAppsWithBackend(relativePath, [{
    uiGraphId: 'ui-graph',
    slug,
  }]);
}

function extractRevisionKey(html: string): string {
  const match = html.match(/"revisionKey":"([^"]+)"/);
  assert.ok(match?.[1], 'web app HTML should embed a revision key');
  return match[1];
}

test('workflow web app publication routes publish multiple project web apps independently', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'MultiPublishedWebApp');
  await writeMultiWebAppProject(created.absolutePath, 'MultiPublishedWebApp', [
    ['ui-one', 'First Web App'],
    ['ui-two', 'Second Web App'],
  ]);

  await withWorkflowApiServer(async (baseUrl) => {
    const initialList = await readJson<{
      webApps: Array<{ uiGraphId: string; name: string; publishedSlug: string | null }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));

    assert.deepEqual(
      initialList.webApps.map((webApp) => [webApp.uiGraphId, webApp.name, webApp.publishedSlug]),
      [
        ['ui-one', 'First Web App', null],
        ['ui-two', 'Second Web App', null],
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
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(
      publishedList.webApps.map((webApp) => [webApp.uiGraphId, webApp.publishedSlug]),
      [
        ['ui-one', 'first-app'],
        ['ui-two', 'second-app'],
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
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(
      afterUnpublishList.webApps.map((webApp) => [webApp.uiGraphId, webApp.publishedSlug]),
      [
        ['ui-one', null],
        ['ui-two', 'second-app'],
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

test('workflow web app publication routes allow batch slug swaps for selected apps', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'SwappedWebApps');
  await writeMultiWebAppProject(created.absolutePath, 'SwappedWebApps', [
    ['ui-one', 'First Web App'],
    ['ui-two', 'Second Web App'],
  ]);

  await withWorkflowApiServer(async (baseUrl) => {
    for (const publications of [
      [
        { uiGraphId: 'ui-one', slug: 'first-app' },
        { uiGraphId: 'ui-two', slug: 'second-app' },
      ],
      [
        { uiGraphId: 'ui-one', slug: 'second-app' },
        { uiGraphId: 'ui-two', slug: 'first-app' },
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
      webApps: Array<{ uiGraphId: string; publishedSlug: string | null }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));
    assert.deepEqual(
      publishedList.webApps.map((webApp) => [webApp.uiGraphId, webApp.publishedSlug]),
      [
        ['ui-one', 'second-app'],
        ['ui-two', 'first-app'],
      ],
    );
  });
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
        isMissingFromProject: boolean;
      }>;
    }>(await fetch(`${baseUrl}/projects/web-apps?${new URLSearchParams({ relativePath: created.relativePath })}`));

    assert.deepEqual(
      staleList.webApps.map((webApp) => [
        webApp.uiGraphId,
        webApp.name,
        webApp.publishedSlug,
        webApp.isMissingFromProject,
      ]),
      [['ui-graph', 'Legacy Web App', 'legacy-web-app', true]],
    );

    await readJson<{ project: unknown }>(await fetch(`${baseUrl}/projects/web-apps/unpublish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relativePath: created.relativePath,
        uiGraphId: 'ui-graph',
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
    const oldRevisionKey = extractRevisionKey(oldHtml);

    await writeWebAppProject(created.absolutePath, 'LatestWebAppRevision', 'Changed Draft Web App With New Text');

    const nextHtml = await (await fetch(`${latestWebAppsBaseUrl}/latest-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const nextRevisionKey = extractRevisionKey(nextHtml);
    assert.notEqual(nextRevisionKey, oldRevisionKey);

    const staleActionResponse = await fetch(`${latestWebAppsBaseUrl}/latest-web-app-revision/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: 'run-button',
        revisionKey: oldRevisionKey,
        state: {
          prompt: 'stale latest',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const staleBody = await staleActionResponse.json() as { error?: string };

    assert.equal(staleActionResponse.status, 409);
    assert.equal(staleBody.error, 'Rivet web app revision mismatch.');
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
          const revisionKey = extractRevisionKey(html);

          const appJsonResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session/app.json`, {
            headers: uiSessionHeaders,
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(appJsonResponse.status, 200);

          const actionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-ui-session/actions/run`, {
            method: 'POST',
            headers: {
              ...uiSessionHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              componentId: 'run-button',
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

test('published filesystem web app actions run through the wrapper execution dependencies', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppAction');
  await writeWebAppProject(created.absolutePath, 'PublishedWebAppAction', 'Published Action App');
  await publishWebApp(created.relativePath, 'published-web-app-action');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const html = await (await fetch(`${webAppsBaseUrl}/published-web-app-action`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const revisionKey = extractRevisionKey(html);
    const actionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-action/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: 'run-button',
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
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Invalid componentId.');
  });
});

test('published filesystem web app actions reject stale published revisions', async () => {
  const created = await workflowMutations.createWorkflowProjectItem('', 'PublishedWebAppRevision');
  await writeWebAppProject(created.absolutePath, 'PublishedWebAppRevision', 'Published Revision App');
  await publishWebApp(created.relativePath, 'published-web-app-revision');

  await withWorkflowExecutionServer(async ({ webAppsBaseUrl }) => {
    const oldHtml = await (await fetch(`${webAppsBaseUrl}/published-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const oldRevisionKey = extractRevisionKey(oldHtml);

    await writeWebAppProject(created.absolutePath, 'PublishedWebAppRevision', 'Republished Revision App');
    await publishWebApp(created.relativePath, 'published-web-app-revision');

    const nextHtml = await (await fetch(`${webAppsBaseUrl}/published-web-app-revision`, {
      signal: AbortSignal.timeout(5000),
    })).text();
    const nextRevisionKey = extractRevisionKey(nextHtml);
    assert.notEqual(nextRevisionKey, oldRevisionKey);

    const staleActionResponse = await fetch(`${webAppsBaseUrl}/published-web-app-revision/actions/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        componentId: 'run-button',
        revisionKey: oldRevisionKey,
        state: {
          prompt: 'stale',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const staleBody = await staleActionResponse.json() as { error?: string };

    assert.equal(staleActionResponse.status, 409);
    assert.equal(staleBody.error, 'Rivet web app revision mismatch.');
  });
});
