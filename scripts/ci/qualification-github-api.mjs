import assert from 'node:assert/strict';

const messages = [
  'Internal Server Error',
  'Server Error',
  'Bad Gateway',
  'Service Unavailable',
  'Not Found',
  'Bad credentials',
  'Validation Failed',
  'Resource not accessible by integration',
  'API rate limit exceeded',
  'You have exceeded a secondary rate limit',
];

// Never persist arbitrary API messages: they can echo request values or credentials.
export function githubFailureDetails(response) {
  const message = response.value?.message;
  const safeMessage =
    typeof message === 'string' && messages.find((value) => message === value || message.startsWith(value + ' '));
  const details = { status: response.status };
  if (response.status >= 400) details.message = safeMessage || 'GitHub API error (details redacted)';
  for (const [key, pattern] of [
    ['requestId', /^[A-Fa-f0-9:]{1,128}$/],
    ['date', /^[A-Za-z0-9,: ]{1,64} GMT$/],
    ['retryAfter', /^\d{1,8}$/],
    ['rateLimitRemaining', /^\d{1,12}$/],
    ['rateLimitReset', /^\d{1,12}$/],
  ]) {
    const value = response.diagnostics?.[key];
    if (typeof value === 'string' && pattern.test(value)) details[key] = value;
  }
  return details;
}

// Transport only: no write retry, workflow dispatch or credential persistence.
export function createQualificationGithubApi({ repository, token, fetch: request = fetch }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.equal(typeof token, 'function');
  return async (method, resource, body) => {
    assert.ok(['GET', 'PATCH', 'POST', 'DELETE'].includes(method));
    assert.ok(typeof resource === 'string' && resource.length > 0 && !resource.startsWith('/'));
    const url = new URL(`https://api.github.com/repos/${repository}/${resource}`);
    assert.ok(url.pathname.startsWith(`/repos/${repository}/`), 'API resource escaped repository');
    const response = await request(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: `Bearer ${await token()}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rivet-qualification-operator',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let value = null;
    try {
      if (raw) value = JSON.parse(raw);
    } catch {
      if (response.ok) throw new SyntaxError('GitHub returned invalid JSON');
    }
    const result = {
      status: response.status,
      value,
      diagnostics: {
        requestId: response.headers.get('x-github-request-id'),
        date: response.headers.get('date'),
        retryAfter: response.headers.get('retry-after'),
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
        rateLimitReset: response.headers.get('x-ratelimit-reset'),
      },
    };
    result.diagnostics = githubFailureDetails(result);
    return result;
  };
}
