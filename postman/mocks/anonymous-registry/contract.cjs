// OCI Distribution HEAD/Bearer examples. No registry access or real tokens.
exports.handler = (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/token') {
    if (url.searchParams.get('scope')?.includes('/private:')) return res.writeHead(403).end();
    return res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"local-anonymous-only"}');
  }
  if (
    req.method === 'HEAD' &&
    /^\/v2\/owner\/(?:public|private|changed|bad-realm)\/manifests\/sha256:[a-f0-9]{64}$/.test(url.pathname)
  ) {
    if (req.headers.authorization !== 'Bearer local-anonymous-only')
      return res
        .writeHead(401, {
          'www-authenticate': `Bearer realm="${url.pathname.includes('bad-realm') ? 'http://unsafe.invalid' : 'https://ghcr.io'}/token",service="ghcr.io"`,
        })
        .end();
    return res
      .writeHead(200, {
        'docker-content-digest': url.pathname.includes('/changed/')
          ? `sha256:${'b'.repeat(64)}`
          : url.pathname.split('/').at(-1),
      })
      .end();
  }
  res.writeHead(501).end();
};
