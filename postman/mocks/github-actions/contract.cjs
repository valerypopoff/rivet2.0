// Minimal synthetic examples of the documented GitHub Actions REST responses.
// No GitHub credentials, real workflow dispatches, downloads or provider writes.
const sha = 'a'.repeat(40);
function createGitHubActionsHandler({ requests = [] } = {}) {
  const reads = new Map();
  return (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://fixture.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    const mode = parts.shift();
    const endpoint = '/' + parts.join('/');
    if (req.method !== 'GET') return res.writeHead(501).end('Only documented GETs are modeled.');
    if (mode.startsWith('ha-')) return haResponse(mode, endpoint, url, res, reads);
    if (mode === 'hang') return;
    if (mode === 'unavailable')
      return res.writeHead(503, { 'content-type': 'text/html' }).end('<html>unavailable</html>');
    if (mode === 'malformed') return res.end('{');
    if (mode === 'redirect') return res.writeHead(302, { location: '/ok' }).end();
    const count = (reads.get(mode) || 0) + 1;
    reads.set(mode, count);
    const repository = { id: 10, full_name: 'fixture/repo' };
    const run = {
      id: 101,
      run_attempt: mode === 'rerun' || (mode === 'download-rerun' && count > 3) ? 2 : 1,
      head_sha: mode === 'stale' ? 'b'.repeat(40) : sha,
      head_branch: mode === 'wrongbranch' ? 'main' : 'develop',
      event: mode === 'pr' ? 'pull_request' : 'push',
      path: '.github/workflows/build.yml',
      repository,
      head_repository: mode === 'fork' ? { id: 11, full_name: 'other/repo' } : repository,
      status: ['pending', 'empty'].includes(mode) || (mode === 'advance' && count < 3) ? 'in_progress' : 'completed',
      conclusion: mode === 'failed' ? 'failure' : mode === 'cancelled' ? 'cancelled' : 'success',
    };
    let body;
    if (endpoint === '/repos/fixture/repo/actions/workflows/build.yml/runs') {
      if (
        url.searchParams.get('event') !== 'push' ||
        url.searchParams.get('branch') !== 'develop' ||
        url.searchParams.get('head_sha') !== sha
      )
        return res.writeHead(501).end('Unexpected workflow identity query.');
      body = { workflow_runs: mode === 'empty' ? [] : [run] };
    } else if (endpoint === '/repos/fixture/repo/actions/runs/101') body = run;
    else if (endpoint === '/repos/fixture/repo/actions/runs/101/artifacts') {
      const artifact = {
        id: mode === 'download-replaced' && count > 4 ? 502 : 501,
        name: `rivet-desktop-web-${sha}`,
        expired: mode === 'expired',
        size_in_bytes: 100,
        workflow_run: {
          id: 101,
          repository_id: 10,
          head_repository_id: 10,
          head_branch: 'develop',
          head_sha: mode === 'foreign-artifact' ? 'b'.repeat(40) : sha,
        },
      };
      body = {
        artifacts: mode === 'missing' ? [] : mode === 'duplicate' ? [artifact, { ...artifact, id: 502 }] : [artifact],
      };
    } else if (endpoint === '/repos/fixture/repo/actions/artifacts/501/zip') {
      const key = `${mode}:download`;
      const downloads = (reads.get(key) || 0) + 1;
      reads.set(key, downloads);
      if (mode === 'download-forbidden') return res.writeHead(403).end();
      if (mode === 'download-broken') return res.writeHead(502).end();
      if (
        mode === 'download-missing' ||
        mode === 'download-rerun' ||
        mode === 'download-replaced' ||
        (mode === 'download-pending' && downloads < 3)
      )
        return res.writeHead(404).end();
      return res.writeHead(302, { location: 'https://artifacts.example.invalid/fixture.zip' }).end();
    } else return res.writeHead(501).end('Endpoint not defined by the GitHub Build-evidence contract.');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
}
module.exports = { createGitHubActionsHandler };

// Attempt-scoped examples for the HA waiter. These exercise the real HTTP
// transport locally; they are not evidence of GitHub availability or queue times.
function haResponse(mode, endpoint, url, res, reads) {
  if (mode === 'ha-hang') return;
  if (mode === 'ha-unauthorized-hang' || mode === 'ha-forbidden-hang') {
    res.writeHead(mode === 'ha-unauthorized-hang' ? 401 : 403);
    res.flushHeaders();
    return;
  }
  if (mode === 'ha-headers-hang') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    return;
  }
  if (mode === 'ha-unavailable') return res.writeHead(503).end('unavailable');
  if (mode === 'ha-forbidden') return res.writeHead(403).end('forbidden');
  const run = {
    id: 101,
    run_attempt: 1,
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/studio-server-images.yml',
    status: 'in_progress',
    repository: { id: 10, full_name: 'fixture/repo' },
    head_repository: { id: 10, full_name: 'fixture/repo' },
  };
  let body;
  if (endpoint === '/repos/fixture/repo/actions/runs/101') body = run;
  else if (endpoint === '/repos/fixture/repo/actions/runs/101/attempts/1/jobs') {
    if (url.searchParams.get('page') !== '1' || url.searchParams.get('per_page') !== '100')
      return res.writeHead(501).end();
    const names = [
      'Create candidate release manifest',
      ...['proxy', 'web', 'api', 'executor'].map((s) => `Scan runtime image (${s})`),
    ];
    body = {
      total_count: names.length,
      jobs: names.map((name, i) => ({
        id: i + 1,
        run_id: 101,
        name,
        status: mode === 'ha-pending' ? 'queued' : 'completed',
        conclusion: mode === 'ha-failed' ? 'failure' : 'success',
      })),
    };
  } else if (endpoint === '/repos/fixture/repo/actions/runs/101/artifacts')
    body = {
      total_count: 1,
      artifacts: [
        {
          id: 501,
          name: 'studio-server-candidate-release-manifest-101-1',
          size_in_bytes: 100,
          expired: false,
          workflow_run: { id: 101, head_sha: sha, head_branch: 'main', repository_id: 10, head_repository_id: 10 },
        },
      ],
    };
  else if (endpoint === '/repos/fixture/repo/actions/artifacts/501/zip') {
    const count = (reads.get(mode) || 0) + 1;
    reads.set(mode, count);
    if (mode === 'ha-download-pending' && count < 3) return res.writeHead(404).end();
    return res.writeHead(302, { location: 'https://artifacts.example.invalid/never-follow' }).end();
  } else return res.writeHead(501).end('Not a modeled HA read');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
