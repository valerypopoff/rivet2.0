/** Bind requests to this document, not a shared cookie: another tab must not refresh an old editor's identity. */
export function bindRestoreWorkspaceEpoch(epoch: unknown, browser: Pick<Window, 'fetch' | 'location'> = window): void {
  if (typeof epoch !== 'string' || !epoch) return;
  const fetch = browser.fetch.bind(browser);
  browser.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    if (url.origin !== browser.location.origin || !url.pathname.startsWith('/api/')) return fetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Rivet-Workspace-Epoch', epoch);
    return fetch(input, { ...init, headers });
  };
}
