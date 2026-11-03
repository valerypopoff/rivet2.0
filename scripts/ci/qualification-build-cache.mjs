import assert from 'node:assert/strict';

/** Keep local builds unchanged. Hosted publication loads into the classic image
 * store: archive verification/scanning must continue to use configuration IDs. */
export function qualificationBuildArgs(kind, args, env = process.env) {
  assert.ok(['actor', 'janitor'].includes(kind), 'Unknown qualification cache scope');
  assert.ok(args.includes('--platform=linux/amd64'), 'Qualification cache scope requires linux/amd64');
  if (!env.RIVET_QUALIFICATION_BUILDER) return ['build', ...args];
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Cached publication is only supported on hosted CI');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Only trusted main publication may write the cache');
  assert.match(env.RIVET_QUALIFICATION_BUILDER, /^[a-z][a-z0-9-]{0,62}$/);
  const cache = env.RIVET_QUALIFICATION_CACHE ?? 'gha';
  assert.ok(['gha', 'off'].includes(cache), 'Unknown qualification cache backend');
  const prefix = ['buildx', 'build', '--builder', env.RIVET_QUALIFICATION_BUILDER, '--load', '--progress=plain'];
  if (cache === 'gha') {
    assert.ok(env.ACTIONS_RUNTIME_TOKEN && env.ACTIONS_RESULTS_URL, 'GHA cache runtime environment is missing');
    const scope = `rivet-qualification-${kind}-linux-amd64`;
    prefix.push(
      '--cache-from',
      `type=gha,version=2,scope=${scope},timeout=60s`,
      '--cache-to',
      `type=gha,version=2,scope=${scope},mode=max,ignore-error=true,timeout=60s`,
    );
  }
  return [...prefix, ...args];
}
