import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const HA_PRODUCERS = [
  'Create candidate release manifest',
  ...['proxy', 'web', 'api', 'executor'].map((service) => `Scan runtime image (${service})`),
];
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
class Unavailable extends Error {}
class Unconfirmed extends Error {}

// This waiter cannot authorize a release. It admits only the exact candidate to
// the existing HA validators; the native late path remains independent of it.
export async function admitHaCandidate({
  repository,
  sha,
  ref,
  runId,
  runAttempt,
  token,
  deadline,
  apiUrl = 'https://api.github.com/',
  fetchRequest = fetch,
  now = Date.now,
  wait = (ms, signal) => sleep(ms, undefined, { signal }),
  signal,
  pollMs = 10_000,
  requestTimeoutMs = 10_000,
}) {
  assert.match(repository ?? '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(sha ?? '', /^[a-f\d]{40}$/i);
  assert.match(ref ?? '', /^refs\/(heads|tags)\/[^\s]+$/);
  assert.ok(positiveId(runId) && positiveId(runAttempt) && token, 'Exact run, attempt and token required');
  assert.ok(
    Number.isFinite(deadline) &&
      Number.isFinite(pollMs) &&
      pollMs > 0 &&
      Number.isFinite(requestTimeoutMs) &&
      requestTimeoutMs > 0,
    'Invalid admission deadline',
  );
  const base = new URL(apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`);
  assert.ok(
    base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)),
  );
  let failures = 0;
  let artifactDeadline;
  let admitted = false;
  const defer = (reason) => ({ outcome: 'deferred', reason });
  const active = () => signal?.throwIfAborted();
  const pause = async (ms) => {
    active();
    await wait(ms, signal);
    active();
  };
  const checkRun = (run) => {
    assert.ok(
      run.id === Number(runId) &&
        run.run_attempt === Number(runAttempt) &&
        run.head_sha === sha &&
        run.path === '.github/workflows/studio-server-images.yml' &&
        run.repository?.full_name === repository &&
        run.head_repository?.full_name === repository &&
        positiveId(run.repository?.id) &&
        run.repository.id === run.head_repository.id,
      'HA run identity/attempt changed; rerun the full producer chain',
    );
    assert.ok(['push', 'workflow_dispatch', 'schedule'].includes(run.event), 'Unsupported HA run event');
    assert.ok(
      ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(run.status),
      'Invalid HA run status',
    );
    if (ref.startsWith('refs/heads/')) assert.equal(run.head_branch, ref.slice(11), 'HA source branch changed');
    if (run.status === 'completed' && run.conclusion !== 'success') throw Error('HA producer run did not succeed');
  };

  async function request(endpoint, { probe = false, until = deadline } = {}) {
    active();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, until - now())));
    let response;
    try {
      response = await fetchRequest(new URL(`repos/${repository}/${endpoint}`, base), {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: probe ? 'manual' : 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      active();
      throw new Unavailable('transport');
    }
    if (probe) {
      await response.body?.cancel();
      return response;
    }
    const knownRateLimit =
      response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    let text = '';
    if (response.ok || (response.status === 403 && !knownRateLimit)) {
      try {
        text = await readBounded(response, 2 * 1024 * 1024);
      } catch (error) {
        active();
        // Without a rate-limit indication, a failed 403 body cannot turn a
        // known authorization failure into permission to retry or defer.
        if (response.status === 403) throw Error('HA admission API returned HTTP 403');
        if (timeout.aborted || error instanceof TypeError) throw new Unavailable('transport');
        throw error;
      }
    } else {
      // Status and headers suffice; do not wait for an irrelevant error body.
      await response.body?.cancel().catch(() => {});
      active();
    }
    if (!response.ok) {
      const rateLimited = knownRateLimit || (response.status === 403 && /secondary rate limit/i.test(text));
      if (rateLimited || response.status >= 500) {
        const retryAfter = response.headers.get('retry-after');
        const retryMs =
          retryAfter == null
            ? NaN
            : /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - now();
        const resetMs = Number(response.headers.get('x-ratelimit-reset')) * 1000 - now();
        const delay = rateLimited
          ? Math.max(
              60_000,
              Number.isFinite(retryMs) ? retryMs : 0,
              response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(resetMs) ? resetMs : 0,
            )
          : Math.max(pollMs, Number.isFinite(retryMs) ? retryMs : 0);
        const error = new Unavailable(rateLimited ? 'rate-limited' : 'server-unavailable');
        error.delay = delay;
        throw error;
      }
      throw Error(`HA admission API returned HTTP ${response.status}`);
    }
    return JSON.parse(text);
  }

  async function list(endpoint, key) {
    let total;
    const items = [];
    for (let page = 1; page <= 10; page++) {
      if (now() >= deadline) throw new Unconfirmed('deadline');
      const data = await request(`${endpoint}?per_page=100&page=${page}`);
      assert.ok(
        Number.isInteger(data.total_count) &&
          data.total_count >= 0 &&
          data.total_count <= 1000 &&
          Array.isArray(data[key]),
        'Invalid or oversized HA evidence listing',
      );
      if (total !== undefined && total !== data.total_count) throw new Unconfirmed('listing-changed');
      total = data.total_count;
      assert.ok(data[key].length <= 100 && data[key].every((item) => positiveId(item.id)), 'Invalid HA evidence page');
      items.push(...data[key]);
      if (items.length >= total) {
        if (items.length !== total || new Set(items.map((item) => item.id)).size !== total)
          throw new Unconfirmed('listing-changed');
        return items;
      }
      if (data[key].length < 100) throw new Unconfirmed('listing-incomplete');
    }
    throw Error('HA evidence listing exceeds page bound');
  }

  while (now() < deadline) {
    active();
    try {
      const run = await request(`actions/runs/${runId}`);
      checkRun(run);
      const jobs = await list(`actions/runs/${runId}/attempts/${runAttempt}/jobs`, 'jobs');
      const ready = HA_PRODUCERS.map((name) => {
        const matches = jobs.filter((job) => job.name === name);
        assert.ok(matches.length <= 1, 'Ambiguous HA producer');
        if (!matches.length) {
          assert.notEqual(run.status, 'completed', 'Missing current-attempt HA producers; rerun the full workflow');
          return false;
        }
        const job = matches[0];
        assert.ok(
          ['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested'].includes(job.status),
          'Invalid HA job status',
        );
        assert.equal(job.run_id, Number(runId), 'Wrong HA producer run');
        if (job.run_attempt !== undefined)
          assert.equal(job.run_attempt, Number(runAttempt), 'Wrong HA producer attempt');
        if (job.head_sha !== undefined) assert.equal(job.head_sha, sha, 'Wrong HA producer source');
        if (job.status !== 'completed') return false;
        assert.equal(job.conclusion, 'success', `HA producer failed: ${name}`);
        return true;
      }).every(Boolean);
      if (ready) {
        artifactDeadline ??= now() + 60_000;
        const name = `studio-server-candidate-release-manifest-${runId}-${runAttempt}`;
        const matches = (await list(`actions/runs/${runId}/artifacts`, 'artifacts')).filter((a) => a.name === name);
        assert.ok(matches.length <= 1, 'Ambiguous HA candidate artifact');
        if (matches.length) {
          const artifact = matches[0];
          const owner = artifact.workflow_run;
          assert.ok(
            artifact.expired === false &&
              artifact.size_in_bytes > 0 &&
              owner?.id === Number(runId) &&
              owner.head_sha === sha &&
              owner.repository_id === run.repository.id &&
              owner.head_repository_id === run.repository.id &&
              owner.head_branch === run.head_branch,
            'Invalid HA candidate artifact ownership',
          );
          checkRun(await request(`actions/runs/${runId}`));
          active();
          if (now() >= deadline) return defer('opportunity-expired');
          // The pinned ID is the irreversible admission boundary. No fallback
          // is allowed even for a subsequent transport or ZIP-visibility failure.
          const admittedAt = now();
          admitted = true;
          const zipDeadline = admittedAt + 60_000;
          while (now() < zipDeadline) {
            const download = await request(`actions/artifacts/${artifact.id}/zip`, { probe: true, until: zipDeadline });
            if (download.status === 302 && download.headers.get('location')) {
              // ZIP visibility can lag by a minute. Recheck at the handoff,
              // not just before that wait, and never fall back after admission.
              assert.ok(now() < zipDeadline, 'HA artifact download deadline exceeded');
              const handoffDeadline = zipDeadline + Math.min(requestTimeoutMs, 10_000);
              checkRun(await request(`actions/runs/${runId}`, { until: handoffDeadline }));
              active();
              assert.ok(now() < handoffDeadline, 'HA artifact handoff deadline exceeded');
              return { outcome: 'admitted', artifactId: artifact.id, admittedAt };
            }
            assert.equal(download.status, 404, 'HA candidate download failed after admission');
            await pause(Math.min(pollMs, zipDeadline - now()));
          }
          throw Error('Exact HA candidate download did not become available');
        }
        assert.ok(
          now() < artifactDeadline,
          'Missing current-attempt HA candidate artifact; rerun the full producer chain',
        );
      }
      failures = 0;
    } catch (error) {
      active();
      if (admitted) throw error;
      if (error instanceof Unavailable) {
        if (++failures > 2 || now() + (error.delay ?? pollMs) >= deadline) return defer(error.message);
        await pause(error.delay ?? pollMs);
        continue;
      }
      if (!(error instanceof Unconfirmed)) throw error;
    }
    if (now() < deadline) await pause(Math.min(pollMs, deadline - now()));
  }
  active();
  return defer('opportunity-expired');
}

export function assertHaJobResults({ enabled, earlyResult, earlyOutcome, lateResult, lateOutcome, recoveryResult }) {
  assert.ok(['true', 'false'].includes(enabled), 'Invalid early HA selection');
  assert.equal(recoveryResult, 'success', 'HA recovery or cleanup failed');
  if (enabled === 'false') assert.equal(earlyResult, 'skipped', 'Disabled early HA must be skipped');
  else {
    assert.equal(earlyResult, 'success', 'Early HA or cleanup failed');
    assert.ok(['proved', 'deferred'].includes(earlyOutcome), 'Missing early HA outcome');
    if (earlyOutcome === 'proved') {
      assert.equal(lateResult, 'skipped', 'HA upgrade must run only once');
      return;
    }
  }
  assert.equal(lateResult, 'success', 'Gated HA or cleanup failed');
  assert.equal(lateOutcome, 'proved', 'Missing gated HA proof');
}

async function readBounded(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert.ok(bytes <= limit, 'HA metadata body exceeds limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function validateHaCandidate(file, env = process.env) {
  const {
    assertStudioServerReleaseManifest,
    assertReleaseManifestMatchesCurrentSource,
    assertReleaseManifestMatchesCurrentChart,
  } = await import('../../deploy/studio-server/scripts/lib/studio-server-release-manifest.mjs');
  const manifest = assertStudioServerReleaseManifest(JSON.parse(await fs.readFile(file, 'utf8')));
  assert.equal(manifest.state, 'candidate');
  assert.equal(manifest.source.repository, env.GITHUB_REPOSITORY);
  assert.equal(manifest.source.ref, env.GITHUB_REF);
  assert.equal(manifest.evidence.candidate.runId, String(env.GITHUB_RUN_ID));
  assert.equal(manifest.evidence.candidate.runAttempt, Number(env.GITHUB_RUN_ATTEMPT));
  assertReleaseManifestMatchesCurrentSource(manifest, env.GITHUB_SHA, { requirePromoted: false });
  assertReleaseManifestMatchesCurrentChart(manifest, path.resolve(import.meta.dirname, '../..'), {
    requirePromoted: false,
  });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'validate') await validateHaCandidate(process.argv[3]);
  else if (process.argv[2] === 'check-results')
    assertHaJobResults({
      enabled: process.env.HA_EARLY_ENABLED,
      earlyResult: process.env.HA_EARLY_RESULT,
      earlyOutcome: process.env.HA_EARLY_OUTCOME,
      lateResult: process.env.HA_LATE_RESULT,
      lateOutcome: process.env.HA_LATE_OUTCOME,
      recoveryResult: process.env.HA_RECOVERY_RESULT,
    });
  else {
    assert.equal(process.argv[2], 'wait');
    const controller = new AbortController();
    const abort = () => controller.abort(Error('HA admission cancelled'));
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      const result = await admitHaCandidate({
        repository: process.env.GITHUB_REPOSITORY,
        sha: process.env.GITHUB_SHA,
        ref: process.env.GITHUB_REF,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        token: process.env.GITHUB_TOKEN,
        apiUrl: process.env.GITHUB_API_URL,
        deadline: Number(process.env.RIVET_HA_PREP_DEADLINE_MS),
        signal: controller.signal,
      });
      await fs.appendFile(
        process.env.GITHUB_OUTPUT,
        `outcome=${result.outcome}\n${result.artifactId ? `artifact_id=${result.artifactId}\n` : ''}`,
      );
      await fs.appendFile(
        process.env.GITHUB_ENV,
        result.outcome === 'deferred'
          ? 'RIVET_HA_DEFERRED=true\n'
          : `RIVET_HA_ADMITTED_DEADLINE_MS=${result.admittedAt + 75 * 60_000}\n`,
      );
      console.log(`HA preparation: ${result.outcome} (${result.reason ?? 'exact artifact pinned'})`);
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  }
}
