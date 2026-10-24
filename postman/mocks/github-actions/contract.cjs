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
      run_attempt: mode === 'rerun' ? 2 : 1,
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
        id: 501,
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
    } else return res.writeHead(501).end('Endpoint not defined by the GitHub Build-evidence contract.');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
}
module.exports = { createGitHubActionsHandler };
