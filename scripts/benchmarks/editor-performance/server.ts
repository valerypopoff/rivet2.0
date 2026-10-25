import { productionServer } from '../../../packages/studio-server-web/production/server.mjs';
import { listenLocal, closeLocal } from './support.mjs';
import type { createFixture } from './fixture';

export async function startFixtureServer(root: string, fixture: Awaited<ReturnType<typeof createFixture>>) {
  const { projects, serializeProject } = fixture;
  const apiCounts: Record<string, number> = {},
    unknown: Record<string, number> = {};
  const assetRequests: { url: string; bytes: number; status: number }[] = [];
  let failCodeEditorOnce = false;
  let bootstrapGate: Promise<void> | undefined;
  let releaseBootstrap = () => {};
  const response = (res, data, status = 200, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(data) : data);
  };
  const { server } = await productionServer({ root });
  const assets = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1'),
        pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        if (bootstrapGate && pathname === '/' && url.searchParams.has('editor')) await bootstrapGate;
        if (failCodeEditorOnce && /\/assets\/CodeEditor-[\w-]+\.js$/.test(pathname)) {
          failCodeEditorOnce = false;
          return response(res, 'Temporary benchmark module failure', 503, 'text/plain');
        }
        res.once('finish', () =>
          assetRequests.push({
            url: req.url!,
            bytes: res.statusCode === 200 ? Number(res.getHeader('content-length') || 0) : 0,
            status: res.statusCode,
          }),
        );
        return assets(req, res);
      }
      apiCounts[pathname] = (apiCounts[pathname] || 0) + 1;
      if (pathname === '/api/config')
        return response(res, {
          executorWsUrl: '/ws/executor/internal',
          remoteDebuggerDefaultWs: '/ws/latest-debugger',
          publishedWorkflowsBasePath: '/workflows',
          latestWorkflowsBasePath: '/workflows-latest',
          publishedAppsBasePath: '/apps',
          latestAppsBasePath: '/apps-latest',
          webAppsAuthMode: 'ui-gate',
        });
      if (pathname.startsWith('/api/config/env/')) return response(res, { value: null });
      if (pathname.endsWith('/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': benchmark\n\n');
        return;
      }
      if (pathname === '/api/workflows/evaluation-runs/library')
        return response(res, {
          revision: 0,
          resourceVersions: { suites: {}, datasets: {} },
          library: {
            version: 1,
            data: { version: 1, suites: [], baselines: [] },
            datasets: [],
            migratedLegacyProjectIds: [],
          },
        });
      if (pathname === '/api/workflows/tree')
        return response(res, {
          root: '/workflows',
          folders: [],
          sync: { epoch: 'benchmark', revision: 0 },
          projects: [...projects.values()].reverse().map((project) => ({
            id: project.metadata.id,
            projectMetadataId: project.metadata.id,
            bundleId: '58019223-bd4e-49c3-a042-321215efaa35',
            name: project.metadata.title,
            fileName: `${project.metadata.title}.rivet-project`,
            absolutePath: `/workflows/${project.metadata.title}.rivet-project`,
            relativePath: `${project.metadata.title}.rivet-project`,
            updatedAt: '2026-10-25T00:00:00Z',
            settings: { status: 'unpublished', endpointName: '', lastPublishedAt: null, publishedWebApps: [] },
          })),
        });
      if (pathname === '/api/projects/load') {
        let body = '';
        for await (const part of req) body += part;
        const title = JSON.parse(body).path.split('/').pop().replace('.rivet-project', '');
        const project = [...projects.values()].find((p) => p.metadata.title === title);
        return project
          ? response(res, { contents: serializeProject(project), datasetsContents: null, revisionId: null })
          : response(res, { error: 'Unknown fixture' }, 404);
      }
      if (pathname.startsWith('/api/workflows/subgraph-projects/')) {
        const [, id, action] = pathname.match(/subgraph-projects\/([^/]+)\/([^/]+)/) || [];
        const project = projects.get(id);
        if (!project) return response(res, { error: 'Unknown fixture' }, 404);
        return response(
          res,
          action === 'execution'
            ? {
                projectContents: serializeProject(project),
                revisionKey: 'fixture',
                sourceProjectPath: `/workflows/${project.metadata.title}.rivet-project`,
              }
            : action === 'preview'
              ? { project }
              : {},
        );
      }
      if (pathname === '/api/workflows/local-editor-recordings/capability') return response(res, { supported: false });
      if (pathname.startsWith('/api/workflows/recordings/')) {
        if (pathname.endsWith('/workflows'))
          return response(res, { workflows: [], totals: { totalRuns: 1, failedRuns: 0, suspiciousRuns: 0 } });
        if (pathname.endsWith('/runs'))
          return response(res, {
            workflowId: '',
            page: 1,
            pageSize: 20,
            totalRuns: 1,
            totalRunsExact: true,
            statusFilter: 'all',
            runs: [fixture.summary],
          });
        if (pathname.endsWith('/summary')) return response(res, fixture.summary);
        if (pathname.endsWith('/recording')) return response(res, fixture.recording, 200, 'text/plain');
        if (pathname.endsWith('/replay-project')) return response(res, fixture.snapshot, 200, 'text/plain');
        return response(res, { error: 'No replay dataset' }, 404);
      }
      unknown[pathname] = (unknown[pathname] || 0) + 1;
      response(res, { error: 'No ambient API in synthetic benchmark' }, 503);
    } catch (error) {
      console.error('Benchmark API failed', error);
      if (!res.headersSent) response(res, { error: 'Invalid fixture request' }, 500);
      else res.destroy();
    }
  });
  const port = await listenLocal(server, Number(process.env.RIVET_EDITOR_BENCH_PORT || 0));
  return {
    url: `http://127.0.0.1:${port}`,
    apiCounts,
    unknown,
    assetRequests,
    failNextCodeEditor: () => {
      failCodeEditorOnce = true;
    },
    holdEditorBootstrap: () => {
      bootstrapGate = new Promise<void>((resolve) => {
        releaseBootstrap = () => {
          bootstrapGate = undefined;
          resolve();
        };
      });
      return releaseBootstrap;
    },
    close: () => {
      releaseBootstrap();
      return closeLocal(server);
    },
  };
}
