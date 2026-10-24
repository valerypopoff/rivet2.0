// Repo-owned Pages metadata contract from prepare-desktop-release-pages.mjs.
// Synthetic bytes/commits only; this mock never reads or proxies a real service.
function metadata(channel, commit) {
  return {
    channel,
    version: '2.0.0',
    commit,
    label: 'existing release',
    stableDownloads: [
      {
        name: 'installer.msi',
        label: 'Windows installer',
        platform: 'windows',
        size: 4,
        url: `downloads/${channel}/installer.msi`,
      },
    ],
    artifacts: [
      {
        name: 'original.msi',
        originalPath: 'windows/original.msi',
        platform: 'windows',
        size: 4,
        url: 'https://github.com/fixture/repository/releases/download/fixed/original.msi',
      },
    ],
  };
}

function createPagesHandler({ commit = 'a'.repeat(40), requests = [] } = {}) {
  return (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const parts = new URL(req.url, `http://${req.headers.host}`).pathname.split('/').filter(Boolean);
    const mode = parts.shift();
    const file = parts.join('/');
    if (
      req.method !== 'GET' ||
      !['ok', 'missing', 'unavailable', 'malformed', 'changed', 'asset-failure', 'optional-missing'].includes(mode)
    ) {
      res.writeHead(501).end('Endpoint not defined by the Pages preservation contract.');
      return;
    }
    const match = /^(developer|official)-release\.json$/.exec(file);
    if (match) {
      if (mode === 'missing' || (mode === 'optional-missing' && match[1] === 'official')) {
        res.writeHead(404).end();
      } else if (mode === 'unavailable') {
        res.writeHead(503, { 'content-type': 'text/html' }).end('<html>unavailable</html>');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(
          mode === 'malformed'
            ? '{'
            : JSON.stringify(metadata(match[1], mode === 'changed' ? 'b'.repeat(40) : commit), null, 2),
        );
      }
    } else if (/^downloads\/(developer|official)\/installer\.msi$/.test(file)) {
      if (mode === 'asset-failure') res.writeHead(503).end('unavailable');
      else res.end('MSI!');
    } else res.writeHead(501).end('Endpoint not defined by the Pages preservation contract.');
  };
}

module.exports = { createPagesHandler, metadata };
