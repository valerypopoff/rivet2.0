import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostedRouteConfig, WorkflowProjectItem } from '../dashboard/types';
import { getPublishedItems } from '../dashboard/publishedItems';

const routeConfig: HostedRouteConfig = {
  executorWsUrl: '',
  remoteDebuggerDefaultWs: '',
  publishedWorkflowsBasePath: '/workflows/',
  latestWorkflowsBasePath: '/workflows-latest',
  internalPublishedWorkflowsBaseUrl: 'http://execution.test:8181/internal/workflows',
  publishedAppsBasePath: '/apps/',
  latestAppsBasePath: '/apps-latest',
  webAppsAuthMode: 'none',
};

function project(id: string, name: string, settings: WorkflowProjectItem['settings']): WorkflowProjectItem {
  return {
    id,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/workflows/${name}.rivet-project`,
    updatedAt: '2026-09-16T00:00:00.000Z',
    settings,
  };
}

test('lists every published endpoint and web app with its owning project and route', () => {
  const endpointAndApp = project('alpha', 'Alpha', {
    status: 'unpublished_changes',
    publicationStatus: 'unpublished_changes',
    endpointName: 'alpha endpoint',
    lastPublishedAt: '2026-09-15T00:00:00.000Z',
    publishedWebApps: [
      {
        uiGraphId: 'alpha-app',
        uiGraphName: 'Alpha console',
        slug: 'alpha-app',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
        status: 'published',
      },
    ],
  });
  const appOnly = project('beta', 'Beta', {
    status: 'unpublished',
    publicationStatus: 'published',
    endpointName: 'unpublished-endpoint-draft',
    lastPublishedAt: null,
    publishedWebApps: [
      {
        uiGraphId: 'beta-app',
        uiGraphName: 'Beta portal',
        slug: 'beta portal',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
        status: 'unpublished_changes',
      },
    ],
  });

  const items = getPublishedItems([appOnly, endpointAndApp], routeConfig);

  assert.deepEqual(
    items.map((item) => ({
      kind: item.kind,
      label: item.label,
      project: item.project.name,
      route: item.route,
      status: item.status,
    })),
    [
      {
        kind: 'endpoint',
        label: 'alpha endpoint',
        project: 'Alpha',
        route: '/workflows/alpha%20endpoint',
        status: 'unpublished_changes',
      },
      {
        kind: 'web-app',
        label: 'Alpha console',
        project: 'Alpha',
        route: '/apps/alpha-app',
        status: 'published',
      },
      {
        kind: 'web-app',
        label: 'Beta portal',
        project: 'Beta',
        route: '/apps/beta%20portal',
        status: 'unpublished_changes',
      },
    ],
  );
});

test('omits unpublished endpoint drafts and projects without publications', () => {
  const unpublished = project('draft', 'Draft', {
    status: 'unpublished',
    publicationStatus: 'unpublished',
    endpointName: 'draft-endpoint',
    lastPublishedAt: null,
    publishedWebApps: [],
  });

  assert.deepEqual(getPublishedItems([unpublished], routeConfig), []);
});

test('treats a published web app from an older tree response as published', () => {
  const legacyTreeProject = project('legacy', 'Legacy', {
    status: 'unpublished',
    endpointName: '',
    lastPublishedAt: null,
    publishedWebApps: [
      {
        uiGraphId: 'legacy-app',
        uiGraphName: 'Legacy app',
        slug: 'legacy-app',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
      },
    ],
  });

  assert.equal(getPublishedItems([legacyTreeProject], routeConfig)[0]?.status, 'published');
});

test('lists the live endpoint name and private route without changing web app routes', () => {
  const changed = project('private', 'Private', {
    status: 'unpublished_changes',
    endpointName: 'renamed-draft',
    publishedEndpointName: 'still-live',
    endpointAccess: 'internal',
    lastPublishedAt: '2026-09-15T00:00:00.000Z',
    publishedWebApps: [{
      uiGraphId: 'app',
      uiGraphName: 'Public app',
      slug: 'public-app',
      publishedAt: '2026-09-15T00:00:00.000Z',
      allowedEmails: [],
      status: 'published',
    }],
  });

  const items = getPublishedItems([changed], routeConfig);
  assert.deepEqual(items.map(({ kind, label, route }) => ({ kind, label, route })), [
    { kind: 'endpoint', label: 'still-live', route: 'http://execution.test:8181/internal/workflows/still-live' },
    { kind: 'web-app', label: 'Public app', route: '/apps/public-app' },
  ]);
});
