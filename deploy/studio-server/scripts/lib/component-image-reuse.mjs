import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './studio-server-release-manifest.mjs';

const proxyRoot = 'deploy/studio-server/images/proxy/';
const shared = 'deploy/studio-server/images/lib/load-env.sh';
const policies = [
  '.dockerignore',
  '.github/workflows/studio-server-images.yml',
  'deploy/studio-server/scripts/lib/component-image-reuse.mjs',
];
const git = (root, args) =>
  execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Conservative closed build-input set. Unsupported Dockerfile constructs cause
 * a fresh build, never a guess that an untracked dependency stayed unchanged. */
export function proxyInputDigest(root, sha) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const dockerfile = git(root, ['show', `${sha}:${proxyRoot}Dockerfile`]);
  const bases = dockerfile.split(/\r?\n/).filter((line) => /^FROM\s/i.test(line));
  if (!bases.length || bases.some((line) => !/^FROM [^\s]+@sha256:[a-f0-9]{64}$/.test(line))) return null;
  for (const line of dockerfile.split(/\r?\n/)) {
    if (/^\s*ADD\s/i.test(line) || /--mount|^\s*(?:ARG|ONBUILD)\s/i.test(line)) return null;
    if (!/^\s*COPY\s/i.test(line)) continue;
    const match = /^COPY\s+(?:--chown=[\w:]+\s+)?([^\s]+)\s+[^\s]+\s*$/.exec(line);
    if (!match || !(match[1].startsWith(proxyRoot) || match[1] === shared) || /[\[\]$*?\\]/.test(match[1])) return null;
  }
  const entries = git(root, ['ls-tree', '-r', '-z', sha, '--', proxyRoot, shared, ...policies])
    .split('\0')
    .filter(Boolean)
    .sort();
  if (entries.some((entry) => !/^100(?:644|755) blob [a-f0-9]+\t/.test(entry))) return null;
  for (const file of [proxyRoot + 'Dockerfile', shared, ...policies])
    if (!entries.some((entry) => entry.endsWith('\t' + file))) return null;
  return (
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify({ protocol: 1, platforms: ['linux/amd64', 'linux/arm64'], buildArgs: {}, entries }))
      .digest('hex')
  );
}

export function proxyReusePlan({ root, sourceSha, repository, predecessor }) {
  const baseline = assertStudioServerReleaseManifest(predecessor, { requirePromoted: true });
  assert.equal(baseline.source.repository, repository);
  assert.equal(baseline.source.ref, 'refs/heads/main');
  // Reuse is an ancestor-source proof, not merely equality of two path names.
  git(root, ['merge-base', '--is-ancestor', baseline.source.sha, sourceSha]);
  const current = proxyInputDigest(root, sourceSha),
    previous = proxyInputDigest(root, baseline.source.sha);
  if (!current || current !== previous) return null;
  if (baseline.imageOrigins?.proxy && baseline.imageOrigins.proxy.inputsDigest !== previous) return null;
  return {
    component: 'proxy',
    image: baseline.images.proxy,
    origin: {
      sourceSha: baseline.imageOrigins?.proxy?.sourceSha ?? baseline.source.sha,
      inputsDigest: current,
      predecessorDigest: getStudioServerReleaseManifestDigest(baseline, { requirePromoted: true }),
    },
  };
}
