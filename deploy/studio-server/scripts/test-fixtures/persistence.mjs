import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const { WebSocketServer } = createRequire(
  new URL('../../../../packages/studio-server-api/package.json', import.meta.url),
)('ws');

export async function persistenceFixture(t, { headers, key = () => 'staging-only', oauth = false }) {
  const relativePath = 'fixture.rivet-project';
  const projectId = randomUUID(),
    revision = randomUUID(),
    publication = randomUUID();
  const requests = [],
    failures = [];
  const authenticate = (req) => {
    const expected = typeof headers === 'function' ? headers() : headers;
    const cookies = (req.headers.cookie ?? '').split(';').map((value) => value.trim());
    if (req.headers.authorization !== expected.authorization || !cookies.includes(expected.cookie)) {
      failures.push(req.url);
      return false;
    }
    if (
      !/^\/apps(?:-latest)?\//.test(req.url) &&
      cookies.some((cookie) => cookie.startsWith('rivet_web_app_oauth_session='))
    ) {
      failures.push(req.url);
      return false;
    }
    return true;
  };
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text && req.headers['content-type']?.includes('application/json') ? JSON.parse(text) : {},
      url = new URL(req.url, 'http://local.invalid'),
      route = url.pathname;
    requests.push(route);
    res.setHeader('content-type', 'application/json');
    const json = (value) => res.end(JSON.stringify(value));
    if (route === '/__rivet_auth') {
      assert.equal(body.key, key());
      res.writeHead(204, { 'set-cookie': 'rivet_ui_token=fixture-only; Path=/' });
      return res.end();
    }
    if (route === '/apps/release-gate-web-app' && url.searchParams.get('auth_action') === 'login') {
      res.writeHead(302, {
        'set-cookie': 'rivet_web_app_oauth_state=fixture; Path=/',
        location: '/dummy?state=fixture',
      });
      return res.end();
    }
    if (route === '/dummy') {
      res.writeHead(303, { location: '/apps/release-gate-web-app/callback?state=fixture' });
      return res.end();
    }
    if (route.endsWith('/callback')) {
      res.writeHead(303, {
        'set-cookie': 'rivet_web_app_oauth_session=fixture; Path=/',
        location: '/apps/release-gate-web-app',
      });
      return res.end();
    }
    if (!authenticate(req)) {
      res.statusCode = 401;
      return json({});
    }
    if (route.endsWith('/web-app-auth') && req.method === 'PUT') {
      assert.equal(body.mode, 'oauth');
      oauth = true;
      return json({});
    }
    if (
      /^\/apps(?:-latest)?\//.test(route) &&
      oauth &&
      !(req.headers.cookie ?? '').split(';').some((cookie) => cookie.trim() === 'rivet_web_app_oauth_session=fixture')
    ) {
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end('<title>Sign in required</title>');
    }
    if (route.endsWith('/trusted-clients/current-request')) return json({ clientAddress: '10.128.0.2' });
    if (route.endsWith('/projects/upload')) return json({ project: { relativePath } });
    if (route.endsWith('/projects/web-apps'))
      return json({
        projectId,
        draftRevisionId: revision,
        publicationVersion: publication,
        project: { projectMetadataId: projectId, revisionId: revision, settings: { publicationVersion: publication } },
      });
    if (route.endsWith('/projects/publish') && body.preconditions.expectedDraftRevisionId !== revision) {
      res.statusCode = 409;
      return json({ error: 'Publishing failed because the project changed' });
    }
    if (route.endsWith('/published-versions')) return json([]);
    if (route.startsWith('/workflows')) return json({ environmentValue: 'managed-persistence' });
    if (route.endsWith('/environment-variables/value')) return json({ value: 'managed-persistence' });
    if (route.endsWith('/environment-variables')) return json({ variables: [{ id: 'value' }] });
    if (route.endsWith('/environment-variables/value/value')) return json({ value: 'managed-persistence' });
    if (route.endsWith('/recordings/workflows'))
      return json({ workflows: [{ workflowId: projectId, totalRuns: 6, project: { relativePath } }] });
    if (route.endsWith('/runs')) return json({ runs: Array.from({ length: 6 }, (_, i) => ({ id: `recording-${i}` })) });
    if (route.endsWith('/replay-project')) return res.end('saved synthetic project');
    if (route.endsWith('/run-statistics/targets')) return json({ targets: [{ target: { workflowId: projectId } }] });
    if (/^\/apps(?:-latest)?\/release-gate-web-app$/.test(route)) {
      res.setHeader('content-type', 'text/html');
      return res.end(
        'Managed release gate app <div data-rivet-web-app-config="{&quot;revisionKey&quot;:&quot;owned-revision&quot;}"></div>',
      );
    }
    return json({});
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    assert.ok(authenticate(req));
    assert.ok(!oauth || req.headers.cookie?.includes('rivet_web_app_oauth_session=fixture'));
    ws.handleUpgrade(req, socket, head, (client) =>
      client.on('message', (raw) => {
        const input = JSON.parse(raw.toString());
        if (input.type === 'client.hello') client.send('{"type":"server.ready"}');
        if (input.type === 'action.start') {
          client.send('{"type":"action.accepted"}');
          client.send('{"type":"action.completed"}');
        }
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const client of ws.clients) client.terminate();
    ws.close();
    server.closeAllConnections();
    server.close();
  });

  return { relativePath, projectId, requests, failures, origin: 'http://127.0.0.1:' + server.address().port };
}
