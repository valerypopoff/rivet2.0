import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { admitHaCandidate, assertHaJobResults, validateHaCandidate } from './ha-candidate-admission.mjs';
import { runHaScript } from './ha-scenario-run.mjs';
import { createStudioServerReleaseManifest } from '../../deploy/studio-server/scripts/lib/studio-server-release-manifest.mjs';
// test-style: fixture-read: reads only the PID marker written by this test's owned child process.
const { createGitHubActionsHandler } = createRequire(import.meta.url)(
  '../../postman/mocks/github-actions/contract.cjs',
);
// Independent expectations: dropping a producer from the implementation must
// not silently remove it from the fixture as well.
const requiredJobs = [
  'Create candidate release manifest',
  ...['proxy', 'web', 'api', 'executor'].map((service) => `Scan runtime image (${service})`),
];

function fixture(change = () => {}) {
  let time = 10_000;
  const run = {
    id: 42,
    run_attempt: 2,
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    path: '.github/workflows/studio-server-images.yml',
    event: 'push',
    status: 'in_progress',
    repository: { full_name: 'owner/repo', id: 7 },
    head_repository: { full_name: 'owner/repo', id: 7 },
  };
  const jobs = requiredJobs.map((name, i) => ({
    id: i + 1,
    run_id: 42,
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  const artifact = {
    id: 81,
    name: 'studio-server-candidate-release-manifest-42-2',
    expired: false,
    size_in_bytes: 200,
    workflow_run: { id: 42, head_sha: run.head_sha, head_branch: 'main', repository_id: 7, head_repository_id: 7 },
  };
  const calls = [];
  const state = { run, jobs, artifacts: [artifact], calls, zipStatus: 302 };
  change(state);
  const options = {
    repository: 'owner/repo',
    sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    runId: 42,
    runAttempt: 2,
    token: 'not-a-real-token',
    deadline: 110_000,
    pollMs: 10_000,
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
    fetchRequest: async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer not-a-real-token');
      calls.push(url.pathname);
      if (state.respond) {
        const response = state.respond(url, options);
        if (response) return response;
      }
      if (url.pathname.endsWith('/zip')) {
        assert.equal(options.redirect, 'manual');
        return new Response(null, {
          status: state.zipStatus,
          headers: state.zipStatus === 302 ? { location: 'https://example.invalid/private' } : {},
        });
      }
      const page = Number(url.searchParams.get('page')) || 1;
      return Response.json(
        url.pathname.endsWith('/jobs')
          ? { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) }
          : url.pathname.endsWith('/artifacts')
            ? { total_count: state.artifacts.length, artifacts: state.artifacts }
            : run,
      );
    },
  };
  return {
    state,
    options,
    advance: (ms) => {
      time += ms;
    },
    execute: () => admitHaCandidate(options),
  };
}

test('only exact successful producers admit a pinned artifact; supported refs do not require workflow completion', async () => {
  for (const [ref, event, branch] of [
    ['refs/heads/main', 'push', 'main'],
    ['refs/heads/staging', 'push', 'staging'],
    ['refs/tags/v1.2.3', 'push', 'main'],
    ['refs/heads/main', 'schedule', 'main'],
    ['refs/heads/main', 'workflow_dispatch', 'main'],
  ]) {
    const f = fixture(({ run, artifacts }) => {
      run.event = event;
      run.head_branch = branch;
      artifacts[0].workflow_run.head_branch = branch;
    });
    f.options.ref = ref;
    assert.deepEqual(await f.execute(), { outcome: 'admitted', artifactId: 81, admittedAt: 10_000 });
    assert.ok(f.state.calls.includes('/repos/owner/repo/actions/runs/42/attempts/2/jobs'));
    assert.equal(f.state.calls.filter((path) => path.endsWith('/42')).length, 3);
  }
});

test('identity, ownership, malformed or failed producers fail closed, including a failure behind a pending job', async () => {
  for (const [target, changes, expected] of [
    [(s) => s.run, [{ run_attempt: 1 }, { head_sha: 'b'.repeat(40) }, { path: 'other.yml' }], /identity\/attempt/],
    [(s) => s.run.head_repository, [{ id: 8 }, { full_name: 'other/repo' }], /identity\/attempt/],
    [(s) => s.run, [{ head_branch: 'develop' }], /source branch/],
    [(s) => s.run, [{ event: 'pull_request' }, { status: 'unknown' }], /Unsupported|Invalid/],
    [(s) => s.jobs[0], [{ run_id: 43 }, { run_attempt: 1 }], /Wrong HA producer/],
    [(s) => s.jobs[1], [{ conclusion: 'cancelled' }, { conclusion: 'skipped' }], /HA producer failed/],
    [(s) => s.artifacts[0], [{ expired: true }, { size_in_bytes: 0 }], /artifact ownership/],
    [
      (s) => s.artifacts[0].workflow_run,
      [{ id: 43 }, { head_sha: 'b'.repeat(40) }, { repository_id: 8 }],
      /artifact ownership/,
    ],
  ])
    for (const change of changes)
      await assert.rejects(
        fixture((s) => Object.assign(target(s), change)).execute(),
        expected,
        JSON.stringify(change),
      );
  await assert.rejects(
    fixture((s) => {
      s.jobs[0].status = 'in_progress';
      s.jobs[4].conclusion = 'failure';
    }).execute(),
    /HA producer failed/,
  );
  for (const key of ['artifacts', 'jobs'])
    await assert.rejects(fixture((s) => s[key].push({ ...s[key][0], id: 82 })).execute(), /Ambiguous/);
  await assert.rejects(
    fixture((s) => {
      s.respond = () => new Response('{broken');
    }).execute(),
    SyntaxError,
  );
});

test('a rerun beginning after artifact discovery cannot admit the earlier attempt', async () => {
  const f = fixture();
  f.state.respond = (url) => {
    if (url.pathname.endsWith('/artifacts')) f.state.run.run_attempt = 3;
  };
  await assert.rejects(f.execute(), /identity\/attempt changed/);
  assert.ok(!f.state.calls.some((p) => p.endsWith('/zip')));
});

test('a rerun or cancellation during ZIP propagation cannot hand off obsolete evidence', async () => {
  for (const change of [
    (run) => {
      run.run_attempt = 3;
    },
    (run) => {
      run.status = 'completed';
      run.conclusion = 'cancelled';
    },
  ]) {
    const f = fixture();
    let downloads = 0;
    f.state.respond = (url) => {
      if (!url.pathname.endsWith('/zip')) return;
      if (++downloads === 1) return new Response(null, { status: 404 });
      change(f.state.run);
    };
    await assert.rejects(f.execute(), /identity\/attempt changed|did not succeed/);
    assert.equal(downloads, 2);
  }
  // A ZIP appearing within its 60-second window still gets one bounded final
  // metadata read. That read must not shorten the ZIP-availability window.
  const f = fixture();
  let reads = 0;
  f.state.respond = (url) => {
    if (url.pathname.endsWith('/zip')) f.advance(59_000);
    if (url.pathname.endsWith('/42') && ++reads === 3) f.advance(2_000);
  };
  assert.equal((await f.execute()).outcome, 'admitted');
});

test('pending gates, slot starvation and unavailable metadata defer without touching candidate downloads', async () => {
  for (const name of requiredJobs)
    for (const state of ['queued', 'missing']) {
      const f = fixture((s) => {
        const index = s.jobs.findIndex((job) => job.name === name);
        if (state === 'missing') s.jobs.splice(index, 1);
        else s.jobs[index].status = state;
      });
      assert.equal((await f.execute()).outcome, 'deferred', name + ': ' + state);
      assert.ok(!f.state.calls.some((p) => p.endsWith('/zip')));
    }
  for (const mutate of [
    (s) => {
      s.respond = () => {
        throw Error('network');
      };
    },
    (s) => {
      s.respond = () => new Response(null, { status: 503 });
    },
    (s) => {
      s.respond = () => new Response(null, { status: 429, headers: { 'retry-after': '1000' } });
    },
    (s) => {
      s.respond = () =>
        new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' } });
    },
  ]) {
    const f = fixture(mutate);
    assert.equal((await f.execute()).outcome, 'deferred');
    assert.ok(!f.state.calls.some((p) => p.endsWith('/zip')));
    assert.ok(f.state.calls.length <= 30);
  }
  await assert.rejects(
    fixture((s) => {
      s.respond = () => new Response(null, { status: 403 });
    }).execute(),
    /HTTP 403/,
  );
  for (const retryAfter of ['1000', new Date(200_000).toUTCString()]) {
    const f = fixture((s) => {
      s.respond = () => new Response(null, { status: 503, headers: { 'retry-after': retryAfter } });
    });
    assert.equal((await f.execute()).outcome, 'deferred');
    assert.equal(f.state.calls.length, 1, 'Do not shorten a server retry delay that exceeds the opportunity');
  }
});

test('pagination, artifact visibility and bounded download 404s retain exact identity', async () => {
  const f = fixture(({ jobs }) => {
    for (let i = 0; i < 101; i++) jobs.unshift({ id: 100 + i, name: `other-${i}`, run_id: 42 });
  });
  let listings = 0,
    downloads = 0;
  f.state.respond = (url) => {
    if (url.pathname.endsWith('/artifacts') && ++listings === 1)
      return Response.json({ total_count: 0, artifacts: [] });
    if (url.pathname.endsWith('/zip') && ++downloads < 3) return new Response(null, { status: 404 });
  };
  assert.equal((await f.execute()).artifactId, 81);
  assert.equal(downloads, 3);
  assert.equal(listings, 2);
  await assert.rejects(
    fixture((s) => {
      s.artifacts = [];
    }).execute(),
    /Missing current-attempt/,
  );
});

test('post-admission failures never defer or replace the pinned artifact', async () => {
  for (const status of [403, 404, 500]) {
    const f = fixture((s) => {
      s.zipStatus = status;
    });
    await assert.rejects(f.execute());
    assert.ok(f.state.calls.filter((p) => p.endsWith('/zip')).every((p) => p.includes('/81/')));
  }
  const f = fixture((s) => {
    s.respond = (url) => {
      if (url.pathname.endsWith('/zip')) throw Error('lost connection');
    };
  });
  await assert.rejects(f.execute(), /transport/);
});

test('body bounds and cancellation do not become successful deferral', async () => {
  await assert.rejects(
    fixture((s) => {
      s.respond = () => new Response(' '.repeat(2 * 1024 * 1024 + 1));
    }).execute(),
    /body exceeds/,
  );
  for (const at of ['fetch', 'backoff', 'pin']) {
    const controller = new AbortController();
    const f = fixture();
    f.options.signal = controller.signal;
    if (at === 'backoff') {
      f.state.jobs[0].status = 'queued';
      f.options.wait = async () => controller.abort(Error('cancelled'));
    } else
      f.state.respond = (url) => {
        if (at === 'fetch' || url.pathname.endsWith('/artifacts')) controller.abort(Error('cancelled'));
      };
    await assert.rejects(f.execute(), /cancelled/);
    assert.ok(!f.state.calls.some((p) => p.endsWith('/zip')));
  }
});

test('only one completed upgrade plus the recovery matrix can reach the evidence assembler', () => {
  const cases = [
    {
      enabled: 'false',
      earlyResult: 'skipped',
      lateResult: 'success',
      lateOutcome: 'proved',
      recoveryResult: 'success',
    },
    {
      enabled: 'true',
      earlyResult: 'success',
      earlyOutcome: 'proved',
      lateResult: 'skipped',
      recoveryResult: 'success',
    },
    {
      enabled: 'true',
      earlyResult: 'success',
      earlyOutcome: 'deferred',
      lateResult: 'success',
      lateOutcome: 'proved',
      recoveryResult: 'success',
    },
  ];
  for (const input of cases) {
    assert.doesNotThrow(() => assertHaJobResults(input));
    for (const recoveryResult of ['failure', 'cancelled', 'skipped', ''])
      assert.throws(() => assertHaJobResults({ ...input, recoveryResult }));
  }
  for (const change of [{ earlyResult: 'cancelled' }, { earlyOutcome: '' }, { lateResult: 'success' }])
    assert.throws(() => assertHaJobResults({ ...cases[1], ...change }));
  for (const change of [{ enabled: '' }, { earlyResult: 'failure' }, { lateOutcome: 'deferred' }])
    assert.throws(() => assertHaJobResults({ ...cases[0], ...change }));
});

test('the common shell skips only expired preparation, propagates errors, and joins children before returning', async () => {
  const env = { RIVET_HA_MODE: 'early', RIVET_HA_PREP_DEADLINE_MS: '10', GITHUB_ENV: 'unused' };
  const writes = [];
  await runHaScript('unused', {
    env,
    now: () => 10,
    append: async (...args) => writes.push(args),
    command: () => assert.fail('expired command started'),
  });
  assert.deepEqual(writes, [['unused', 'RIVET_HA_DEFERRED=true\n']]);
  let settled = false;
  await assert.rejects(
    runHaScript('unused', {
      env,
      now: () => 5,
      command: async () => {
        throw Error('setup failed');
      },
      settle: async () => {
        settled = true;
      },
    }),
    /setup failed/,
  );
  assert.equal(settled, true);
  await assert.rejects(
    runHaScript('unused', {
      env: { ...env, RIVET_HA_PHASE: 'candidate', RIVET_HA_ADMITTED_DEADLINE_MS: '3' },
      now: () => 5,
    }),
    /deadline exceeded/,
  );
  let cleanup = false;
  await runHaScript('unused', {
    env: { ...env, RIVET_HA_PHASE: 'cleanup', RIVET_HA_DEFERRED: 'true' },
    now: () => 50,
    command: async () => {
      cleanup = true;
    },
    settle: async () => {},
  });
  assert.equal(cleanup, true);
});

test('admission uses the remaining original window rather than the five-minute preparation cap', async () => {
  for (const elapsed of [120_000, 590_000]) {
    let budget;
    let called = false;
    await runHaScript('unused', {
      env: { RIVET_HA_MODE: 'early', RIVET_HA_PHASE: 'admission', RIVET_HA_PREP_DEADLINE_MS: '600000' },
      now: () => elapsed,
      timeout: (ms) => {
        budget = ms;
        return new AbortController().signal;
      },
      command: async () => {
        called = true;
      },
      settle: async () => {},
    });
    assert.equal(budget, 600_000 - elapsed + 70_000);
    assert.equal(called, true);
  }
  const writes = [];
  await runHaScript('unused', {
    env: {
      RIVET_HA_MODE: 'early',
      RIVET_HA_PHASE: 'admission',
      RIVET_HA_PREP_DEADLINE_MS: '600000',
      GITHUB_ENV: 'unused',
    },
    now: () => 600_000,
    append: async (...args) => writes.push(args),
    command: () => assert.fail('An expired waiter started'),
    timeout: () => assert.fail('An expired waiter acquired another budget'),
  });
  assert.deepEqual(writes, [['unused', 'RIVET_HA_DEFERRED=true\n']]);
});

test(
  'actual HTTP handles eventual ZIP visibility, overload, stalled reads and permission errors',
  { timeout: 10_000 },
  async (t) => {
    const requests = [];
    const server = createServer(createGitHubActionsHandler({ requests }));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const read = (mode, options = {}) =>
      admitHaCandidate({
        repository: 'fixture/repo',
        sha: 'a'.repeat(40),
        ref: 'refs/heads/main',
        runId: 101,
        runAttempt: 1,
        token: 'synthetic',
        apiUrl: `http://127.0.0.1:${server.address().port}/${mode}/`,
        deadline: Date.now() + 5000,
        pollMs: 5,
        requestTimeoutMs: 1000,
        signal: t.signal,
        ...options,
      });
    for (const [mode, expected, requestTimeoutMs] of [
      ['ha-download-pending', 'admitted', 1000],
      ['ha-unavailable', 'deferred', 1000],
      ['ha-hang', 'deferred', 50],
      ['ha-headers-hang', 'deferred', 50],
      ['ha-unauthorized-hang', /HTTP 401/, 1000],
      ['ha-forbidden-hang', /HTTP 403/, 1000],
    ]) {
      const operation = read(mode, {
        requestTimeoutMs,
        fetchRequest: async (...args) => {
          const response = await fetch(...args);
          // Cut the unreadable 403 body after the real client has its headers.
          // This tests status handling without depending on a short wall-clock race.
          if (mode === 'ha-forbidden-hang') server.closeAllConnections();
          return response;
        },
      });
      if (expected instanceof RegExp) await assert.rejects(operation, expected, mode);
      else assert.equal((await operation).outcome, expected, mode);
    }
    const controller = new AbortController();
    server.once('request', () => controller.abort(Error('cancelled during HTTP read')));
    await assert.rejects(read('ha-hang', { signal: controller.signal }), /cancelled during HTTP read/);
    assert.ok(requests.some((r) => r.includes('/attempts/1/jobs')));
    assert.equal(
      requests.filter((r) => r === 'GET /ha-download-pending/repos/fixture/repo/actions/artifacts/501/zip').length,
      3,
    );
    assert.ok(requests.every((r) => r.startsWith('GET /ha-')));
    for (const mode of ['ha-unauthorized-hang', 'ha-forbidden-hang'])
      assert.equal(requests.filter((r) => r.startsWith(`GET /${mode}/`)).length, 1);
  },
);

test('downloaded candidates must match the caller attempt, full ref, source and chart before image use', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-admission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rootDir = path.resolve(import.meta.dirname, '../..');
  const manifest = createStudioServerReleaseManifest({
    rootDir,
    source: { repository: 'fixture/repo', ref: 'refs/tags/v1.2.3', sha: 'a'.repeat(40) },
    images: Object.fromEntries(
      ['proxy', 'web', 'api', 'executor'].map((s) => [
        s,
        { repository: `example.test/${s}`, digest: `sha256:${'a'.repeat(64)}` },
      ]),
    ),
    candidateEvidence: { workflow: 'Build Images', runId: '101', runAttempt: 1 },
  });
  const file = path.join(directory, 'candidate.json');
  await fs.writeFile(file, JSON.stringify(manifest));
  const env = {
    GITHUB_REPOSITORY: 'fixture/repo',
    GITHUB_REF: 'refs/tags/v1.2.3',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '101',
    GITHUB_RUN_ATTEMPT: '1',
  };
  await validateHaCandidate(file, env);
  for (const change of [
    { GITHUB_RUN_ID: '102' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_REPOSITORY: 'other/repo' },
  ])
    await assert.rejects(validateHaCandidate(file, { ...env, ...change }));
});

test(
  'the Linux CI shell terminates and joins its actual child process on cancellation',
  { skip: process.platform !== 'linux', timeout: 10_000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-shell-'));
    const controller = new AbortController();
    let stopped;
    t.after(async () => {
      controller.abort(Error('cancel the fixture'));
      await stopped;
      await fs.rm(directory, { recursive: true, force: true });
    });
    const marker = path.join(directory, 'child.pid');
    const script = path.join(directory, 'step.sh');
    await fs.writeFile(
      script,
      `exec node -e 'require("node:fs").writeFileSync(process.env.HA_MARKER,String(process.pid));setInterval(()=>{},1000)'`,
    );
    const running = runHaScript(script, {
      env: {
        ...process.env,
        RIVET_HA_MODE: 'early',
        RIVET_HA_PHASE: 'admission',
        RIVET_HA_PREP_DEADLINE_MS: String(Date.now() + 600_000),
        HA_MARKER: marker,
      },
      signal: AbortSignal.any([controller.signal, t.signal]),
    });
    let stoppedEarly = false;
    stopped = running.then(
      () => undefined,
      (error) => {
        stoppedEarly = true;
        return error;
      },
    );
    let pid;
    const until = Date.now() + 5000;
    while (!pid && !stoppedEarly && Date.now() < until) {
      try {
        pid = Number(await fs.readFile(marker, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    controller.abort(Error('cancel the fixture'));
    const failure = await stopped;
    assert.match(failure?.message ?? '', /cancel the fixture/);
    assert.ok(pid, 'The actual child must have started');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await fs.writeFile(script, 'true');
    await runHaScript(script, { env: { ...process.env, RIVET_HA_MODE: 'after-gates', RIVET_HA_PHASE: 'cleanup' } });
  },
);
