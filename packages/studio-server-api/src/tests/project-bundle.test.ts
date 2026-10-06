// test-style: fixture-read: reads only test-owned staged manifests and generated ZIP files.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { loadProjectBundle, serializeProject } from '@valerypopoff/rivet2-node';
import {
  SubGraphNodeImpl,
  ReferencedGraphAliasNodeImpl,
  getGraphBoundary,
  loadProjectFromString,
  type GraphId,
  type ProjectId,
  type NodePrefabId,
  type DataId,
} from '@valerypopoff/rivet2-node';
import { collectProjectBundle } from '../routes/workflows/project-bundle.js';
import { ProjectBundleJobs } from '../routes/workflows/project-bundle-jobs.js';
import { projectBundleFixture, extractProjectBundleFixture } from './helpers/project-bundle-fixture.js';
import { createSavedBundleSource } from '../routes/workflows/project-bundle.js';
import { projectBundleJobs } from '../routes/workflows/project-bundle-jobs.js';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { getExpectedProxyAuthToken } from '../auth.js';

test('export closure packages actual bytes and produces a relocatable locally runnable ZIP', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-test-'));
  const jobs = new ProjectBundleJobs(path.join(temporary, 'jobs'));
  try {
    const fixture = projectBundleFixture(),
      requestId = randomUUID();
    // A/main → B/main → A/helper is not recursive, despite its project-level cycle.
    const helperId = 'root-helper' as GraphId;
    const helper = structuredClone(fixture.child.project.graphs[fixture.child.project.metadata.mainGraphId!]!);
    helper.metadata!.id = helperId;
    fixture.root.project.graphs[helperId] = helper;
    const childGraph = fixture.child.project.graphs[fixture.child.project.metadata.mainGraphId!]!;
    const childText = childGraph.nodes.find((node) => node.type === 'text')!;
    const backToHelper = SubGraphNodeImpl.create();
    backToHelper.data.targetProjectId = fixture.root.project.metadata.id;
    backToHelper.data.targetVersion = 'latest';
    backToHelper.data.graphId = helperId;
    backToHelper.data.targetBoundary = getGraphBoundary(fixture.root.project, helperId)!;
    childGraph.nodes = childGraph.nodes.filter((node) => node !== childText);
    childGraph.nodes.push(backToHelper);
    const connection = childGraph.connections.find((edge) => edge.outputNodeId === childText.id)!;
    connection.outputNodeId = backToHelper.id;
    connection.outputId = 'result' as typeof connection.outputId;
    fixture.root.projectContents = serializeProject(fixture.root.project) as string;
    fixture.child.projectContents = serializeProject(fixture.child.project) as string;
    const job = await jobs.start(fixture.source, 'latest', requestId);
    assert.equal((await jobs.start(fixture.source, 'latest', requestId)).id, job.id);
    await assert.rejects(jobs.start(fixture.source, 'latest'), /Another project bundle/);
    let status = await jobs.status(job.id);
    for (let attempt = 0; attempt < 200 && ['collecting', 'packaging'].includes(status.phase); attempt++) {
      await delay(10);
      status = await jobs.status(job.id);
    }
    assert.equal(status.phase, 'ready', JSON.stringify(status));
    assert.equal(status.projects, 2);
    const download = await jobs.download(job.id);
    const bytes = await fs.readFile(download.archive);
    assert.equal(bytes.length, status.archiveBytes);
    const extracted = path.join(temporary, 'elsewhere');
    await extractProjectBundleFixture(bytes, extracted);
    const bundle = await loadProjectBundle(path.join(extracted, 'rivet-bundle.json'));
    const processor = bundle.createProcessor();
    try {
      assert.equal((await processor.run()).result?.value, 'child-result');
    } finally {
      processor.dispose();
    }
    // Disposing an export may not remove a file from an active range/download stream.
    download.release();
    let releaseStat!: () => void, enteredStat!: () => void;
    const heldStat = new Promise<void>((resolve) => {
      releaseStat = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredStat = resolve;
    });
    const originalLstat = fs.lstat;
    const statMock = t.mock.method(fs, 'lstat', async (location: Parameters<typeof fs.lstat>[0], ...args: []) => {
      if (location === download.archive) {
        enteredStat();
        await heldStat;
      }
      return originalLstat(location, ...args);
    });
    const pendingDownload = jobs.download(job.id);
    await entered;
    try {
      // Two callers may cancel the same export after a retried/lost acknowledgement.
      // Hold the journal rename while both requests are pending.
      let renames = 0;
      let releaseRenames!: () => void;
      const heldRename = new Promise<void>((resolve) => {
        releaseRenames = resolve;
      });
      let enterRename!: () => void;
      const enteredRename = new Promise<void>((resolve) => {
        enterRename = resolve;
      });
      const originalRename = fs.rename;
      const renameMock = t.mock.method(
        fs,
        'rename',
        async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
          if (to === path.join(path.dirname(download.archive), 'status.json')) {
            ++renames;
            enterRename();
            await heldRename;
          }
          return originalRename(from, to);
        },
      );
      try {
        const cancelled = Promise.all([jobs.cancel(job.id), jobs.cancel(job.id)]);
        await enteredRename;
        releaseRenames();
        await cancelled;
        assert.equal(renames, 1, 'concurrent requests share one journal write');
      } finally {
        releaseRenames();
        renameMock.mock.restore();
      }
      assert.equal((await fs.stat(download.archive)).isFile(), true);
      assert.equal((await jobs.status(job.id)).phase, 'cancelled');
      await assert.rejects(jobs.download(job.id), /not ready/);
      // A retained cancelled download still consumes scratch, until its lease ends.
      await withEnvOverride('RIVET_PROJECT_BUNDLE_SCRATCH_MAX_BYTES', String(status.archiveBytes), async () => {
        const next = await jobs.start(fixture.source, 'latest');
        let nextStatus = await jobs.status(next.id);
        for (let attempt = 0; attempt < 100 && nextStatus.phase === 'collecting'; attempt++) {
          await delay(10);
          nextStatus = await jobs.status(next.id);
        }
        assert.equal(nextStatus.phase, 'failed');
        assert.match(nextStatus.error!, /scratch budget/);
      });
    } finally {
      releaseStat();
      statMock.mock.restore();
    }
    (await pendingDownload).release();
    await jobs.cleanup();
    await assert.rejects(fs.stat(download.archive), { code: 'ENOENT' });
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('collection is coherent, bounded, deduplicated and checks source changes before publication', async () => {
  const f = projectBundleFixture();
  f.root.project.references = [{ id: f.child.project.metadata.id }];
  f.root.projectContents = serializeProject(f.root.project) as string;
  const written = new Map<string, string>();
  const capture = await collectProjectBundle({
    source: f.source,
    rootVersion: 'latest',
    signal: new AbortController().signal,
    writeFile: async (name, content) => {
      written.set(name, content);
    },
    progress() {},
  });
  assert.equal(capture.manifest.artifacts.length, 2);
  assert.equal(capture.manifest.references.length, 2);
  await capture.verify();
  f.child.datasetsContents = 'changed';
  await assert.rejects(capture.verify(), /changed while exporting/);
  await assert.rejects(
    collectProjectBundle({
      source: f.source,
      rootVersion: 'latest',
      maxBytes: 1,
      signal: new AbortController().signal,
      writeFile: async () => {},
      progress() {},
    }),
    /size limit/,
  );
});

test('closure includes prefab and non-main dependencies, legacy back-edges, attachments and another root version', async () => {
  const f = projectBundleFixture();
  const third = structuredClone(f.child);
  third.project.metadata.id = 'third' as ProjectId;
  third.project.metadata.title = 'Third';
  third.projectContents = serializeProject(third.project) as string;
  const rootGraph = f.root.project.graphs[f.root.project.metadata.mainGraphId!]!;
  const call = rootGraph.nodes.find((node) => node.type === 'subGraph')!;
  const prefabId = 'portable-prefab' as NodePrefabId;
  f.root.project.nodePrefabs = { [prefabId]: { id: prefabId, sourceNode: structuredClone(call) } };
  rootGraph.nodes = rootGraph.nodes.map((node) =>
    node === call ? { ...node, type: 'nodePrefabInstance', data: { prefabId } } : node,
  );
  f.root.project.references = [{ id: f.child.project.metadata.id }];
  f.child.project.references = [{ id: f.root.project.metadata.id }, { id: third.project.metadata.id }];
  const childGraph = f.child.project.graphs[f.child.project.metadata.mainGraphId!]!;
  const alias = ReferencedGraphAliasNodeImpl.create();
  alias.data.projectId = third.project.metadata.id;
  alias.data.graphId = third.project.metadata.mainGraphId!;
  const oldText = childGraph.nodes.find((node) => node.type === 'text')!;
  childGraph.nodes = childGraph.nodes.map((node) => (node === oldText ? alias : node));
  const edge = childGraph.connections.find((connection) => connection.outputNodeId === oldText.id)!;
  edge.outputNodeId = alias.id;
  edge.outputId = 'result' as typeof edge.outputId;
  const publishedRoot = structuredClone(third);
  publishedRoot.project.metadata.id = f.root.project.metadata.id;
  publishedRoot.selectedVersion = 'published';
  publishedRoot.projectContents = serializeProject(publishedRoot.project) as string;
  const extra = structuredClone(third.project.graphs[third.project.metadata.mainGraphId!]!);
  const extraId = 'non-main' as GraphId;
  extra.metadata!.id = extraId;
  const toThird = SubGraphNodeImpl.create();
  toThird.data.targetProjectId = third.project.metadata.id;
  toThird.data.graphId = third.project.metadata.mainGraphId!;
  toThird.data.targetBoundary = getGraphBoundary(third.project, toThird.data.graphId)!;
  const toPublishedRoot = structuredClone(toThird);
  toPublishedRoot.id = 'published-root-call' as typeof toPublishedRoot.id;
  toPublishedRoot.data.targetProjectId = f.root.project.metadata.id;
  toPublishedRoot.data.targetVersion = 'published';
  const disabled = structuredClone(toThird);
  disabled.id = 'ignored-call' as typeof disabled.id;
  disabled.disabled = true;
  disabled.data.targetProjectId = 'not-present' as ProjectId;
  extra.nodes.push(toThird, toPublishedRoot, disabled);
  f.root.project.graphs[extraId] = extra;
  f.root.project.data = { ['embedded' as DataId]: 'embedded attachment bytes' };
  f.root.projectContents = serializeProject(f.root.project) as string;
  f.child.projectContents = serializeProject(f.child.project) as string;
  const snapshots = new Map(
    [f.root, f.child, third, publishedRoot].map((snapshot) => [
      JSON.stringify([snapshot.project.metadata.id, snapshot.selectedVersion]),
      snapshot,
    ]),
  );
  const reads: string[] = [];
  const files = new Map<string, string>();
  const capture = await collectProjectBundle({
    source: {
      root: async () => f.root,
      target: async (target) => {
        reads.push(JSON.stringify([target.projectId, target.version]));
        const snapshot = snapshots.get(reads.at(-1)!);
        if (!snapshot) throw new Error('Missing fixture target');
        return snapshot;
      },
      reference: async (projectId) => {
        const snapshot = snapshots.get(JSON.stringify([projectId, 'latest']));
        if (!snapshot) throw new Error('Missing fixture reference');
        return snapshot;
      },
    },
    rootVersion: 'latest',
    signal: new AbortController().signal,
    writeFile: async (name, contents) => {
      files.set(name, contents);
    },
    progress() {},
  });
  assert.equal(capture.manifest.artifacts.length, 4);
  assert.equal(new Set(reads).size, reads.length, 'explicit targets captured once before verification');
  assert.equal(capture.manifest.references.length, 3, 'legacy cycle terminates at the root');
  assert.ok(capture.manifest.exportingRuntimeVersion);
  const rootArtifact = capture.manifest.artifacts.find((artifact) => artifact.id === capture.manifest.rootArtifact)!;
  assert.deepEqual(loadProjectFromString(files.get(rootArtifact.project.path)!).data, f.root.project.data);
  await capture.verify();
});

test('cancel settles a hung source and restart marks unfinished jobs interrupted', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-cancel-'));
  const jobs = new ProjectBundleJobs(path.join(temporary, 'jobs'));
  try {
    const f = projectBundleFixture();
    const started = await jobs.start({ ...f.source, root: () => new Promise(() => {}) }, 'latest');
    await jobs.cancel(started.id);
    await assert.rejects(jobs.status(started.id), /not found/);
    const id = randomUUID(),
      dir = path.join(temporary, 'restart', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({ ...started, id, phase: 'packaging' }));
    const restarted = new ProjectBundleJobs(path.dirname(dir));
    try {
      assert.equal((await restarted.status(id)).phase, 'interrupted');
    } finally {
      await restarted.dispose();
    }
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('unavailable scratch rejects exports but cannot poison shutdown', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-init-failure-'));
  const root = path.join(temporary, 'not-a-directory');
  await fs.writeFile(root, 'fixture');
  const jobs = new ProjectBundleJobs(root);
  try {
    await assert.rejects(jobs.start(projectBundleFixture().source, 'latest'));
    await jobs.dispose();
    await jobs.dispose();
    const unopenedRoot = path.join(temporary, 'never-started');
    const unopened = new ProjectBundleJobs(unopenedRoot);
    await unopened.dispose();
    await assert.rejects(unopened.start(projectBundleFixture().source, 'latest'), { status: 503 });
    await assert.rejects(fs.stat(unopenedRoot), { code: 'ENOENT' });
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('restart reconciles ready and interrupted scratch, and keeps failed cleanup tracked', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-restart-'));
  const jobs = new ProjectBundleJobs(temporary);
  let restarted: ProjectBundleJobs | undefined;
  let faulted: ProjectBundleJobs | undefined;
  try {
    const fixture = projectBundleFixture();
    const started = await jobs.start(fixture.source, 'latest');
    let ready = await jobs.status(started.id);
    for (let attempt = 0; attempt < 200 && ['collecting', 'packaging'].includes(ready.phase); attempt++) {
      await delay(10);
      ready = await jobs.status(started.id);
    }
    assert.equal(ready.phase, 'ready');
    await jobs.dispose();
    const directory = path.join(temporary, ready.id);
    const staging = path.join(directory, 'staging');
    await fs.mkdir(staging);
    await fs.writeFile(path.join(staging, 'leftover'), 'ready staging retained across a crash');
    await fs.writeFile(path.join(directory, 'bundle.partial'), 'incomplete archive');
    const interruptedId = randomUUID();
    const interrupted = path.join(temporary, interruptedId);
    await fs.mkdir(path.join(interrupted, 'staging'), { recursive: true });
    await fs.writeFile(
      path.join(interrupted, 'status.json'),
      JSON.stringify({ ...started, id: interruptedId, phase: 'packaging' }),
    );
    await fs.writeFile(path.join(interrupted, 'bundle.zip'), 'renamed but not durably published');
    restarted = new ProjectBundleJobs(temporary);
    assert.equal((await restarted.status(ready.id)).phase, 'ready');
    assert.equal((await restarted.status(interruptedId)).phase, 'interrupted');
    for (const removed of [
      staging,
      path.join(directory, 'bundle.partial'),
      path.join(interrupted, 'staging'),
      path.join(interrupted, 'bundle.zip'),
    ])
      await assert.rejects(fs.stat(removed), { code: 'ENOENT' });
    const download = await restarted.download(ready.id);
    assert.equal((await fs.stat(download.archive)).size, ready.archiveBytes);
    download.release();
    await restarted.dispose();

    // Restart cleanup failures must remain an owned job, not silently skip its bytes.
    await fs.mkdir(staging);
    const originalRm = fs.rm;
    const rmMock = t.mock.method(
      fs,
      'rm',
      async (location: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
        if (location === staging || location === directory)
          throw Object.assign(new Error('Owned restart removal failure'), { code: 'EACCES' });
        return originalRm(location, options);
      },
    );
    faulted = new ProjectBundleJobs(temporary);
    try {
      await assert.rejects(faulted.start(fixture.source, 'latest'), { code: 'EACCES' });
      assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')).phase, 'failed');
      assert.equal((await fs.stat(download.archive)).isFile(), true);
    } finally {
      rmMock.mock.restore();
    }
    await faulted.cleanup();
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    const retry = await faulted.start(fixture.source, 'latest');
    await faulted.cancel(retry.id);
  } finally {
    await jobs.dispose();
    await restarted?.dispose();
    await faulted?.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('a colliding request ID cannot delete unclaimed scratch', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-collision-'));
  const id = randomUUID();
  const existing = path.join(temporary, id);
  await fs.mkdir(existing);
  const marker = path.join(existing, 'keep.txt');
  await fs.writeFile(marker, 'unclaimed fixture');
  const jobs = new ProjectBundleJobs(temporary);
  try {
    await assert.rejects(jobs.start(projectBundleFixture().source, 'latest', id), { code: 'EEXIST' });
    assert.equal(await fs.readFile(marker, 'utf8'), 'unclaimed fixture');
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('preparation owns staging cleanup until completion and blocks retry when removal fails', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-staging-'));
  const jobs = new ProjectBundleJobs(temporary);
  let releaseCleanup!: () => void;
  const heldCleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let enteredCleanup!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredCleanup = resolve;
  });
  const originalRm = fs.rm;
  let failCleanup = false;
  let id: string | undefined;
  const rmMock = t.mock.method(
    fs,
    'rm',
    async (location: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
      if (String(location).endsWith(`${path.sep}staging`)) {
        enteredCleanup();
        await heldCleanup;
        if (failCleanup) throw Object.assign(new Error('Owned staging removal failed'), { code: 'EACCES' });
      }
      if (failCleanup && id && location === path.join(temporary, id))
        throw Object.assign(new Error('Owned directory removal failed'), { code: 'EACCES' });
      return originalRm(location, options);
    },
  );
  try {
    const fixture = projectBundleFixture();
    const started = await jobs.start(fixture.source, 'latest');
    id = started.id;
    await entered;
    const pendingStatus = jobs.status(started.id);
    const unavailable = assert.rejects(jobs.download(started.id), /not ready/);
    await assert.rejects(jobs.start(fixture.source, 'latest'), /Another project bundle/);
    failCleanup = true;
    releaseCleanup();
    const status = await pendingStatus;
    assert.equal(status.phase, 'failed');
    assert.match(status.error!, /scratch cleanup failed/);
    await unavailable;
    await assert.rejects(jobs.start(fixture.source, 'latest'), { code: 'EACCES' });
    assert.equal(
      (await fs.stat(path.join(temporary, started.id, 'bundle.zip'))).isFile(),
      true,
      'failed scratch stays owned',
    );
    rmMock.mock.restore();
    await jobs.cleanup();
    const next = await jobs.start(fixture.source, 'latest');
    await jobs.cancel(next.id);
  } finally {
    releaseCleanup();
    rmMock.mock.restore();
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('failed expiry removal stays tracked and retryable instead of orphaning scratch', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-removal-'));
  const jobs = new ProjectBundleJobs(temporary);
  try {
    const fixture = projectBundleFixture();
    const started = await jobs.start(fixture.source, 'latest');
    let status = await jobs.status(started.id);
    for (let attempt = 0; attempt < 200 && ['collecting', 'packaging'].includes(status.phase); attempt++) {
      await delay(10);
      status = await jobs.status(started.id);
    }
    assert.equal(status.phase, 'ready');
    // Wait for staging cleanup too; ready publication can precede final disposal.
    const downloaded = await jobs.download(started.id);
    downloaded.release();
    const directory = path.join(temporary, started.id);
    const originalRm = fs.rm;
    const rmMock = t.mock.method(
      fs,
      'rm',
      async (location: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
        if (location === directory) throw Object.assign(new Error('Owned fixture removal failed'), { code: 'EACCES' });
        return originalRm(location, options);
      },
    );
    const nowMock = t.mock.method(Date, 'now', () => Date.parse(status.expiresAt) + 1);
    try {
      // Disposal waits for any remaining prepare work, while retaining ready archives.
      await jobs.dispose();
      await assert.rejects(jobs.cleanup(), { code: 'EACCES' });
      await assert.rejects(jobs.cleanup(), { code: 'EACCES' });
      assert.equal((await fs.stat(downloaded.archive)).isFile(), true);
    } finally {
      rmMock.mock.restore();
      nowMock.mock.restore();
    }
    const nowRetry = t.mock.method(Date, 'now', () => Date.parse(status.expiresAt) + 1);
    try {
      await jobs.cleanup();
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
      await assert.rejects(jobs.status(started.id), /not found/);
    } finally {
      nowRetry.mock.restore();
    }
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('export rejects incompatible ports, wrong versions and recursive cross-project cycles without executing nodes', async () => {
  const collect = (f: ReturnType<typeof projectBundleFixture>) =>
    collectProjectBundle({
      source: f.source,
      rootVersion: 'latest',
      signal: new AbortController().signal,
      writeFile: async () => {},
      progress() {},
    });
  const ports = projectBundleFixture();
  ports.child.project.graphs[ports.child.project.metadata.mainGraphId!]!.nodes = [];
  ports.child.projectContents = serializeProject(ports.child.project) as string;
  await assert.rejects(collect(ports), /incompatible boundary/);
  const version = projectBundleFixture();
  version.child.selectedVersion = 'published';
  await assert.rejects(collect(version), /could not be captured/);
  const cycle = projectBundleFixture(),
    call = SubGraphNodeImpl.create();
  call.data.targetProjectId = cycle.root.project.metadata.id;
  call.data.targetVersion = 'latest';
  call.data.graphId = cycle.root.project.metadata.mainGraphId! as GraphId;
  call.data.targetBoundary = getGraphBoundary(cycle.root.project, call.data.graphId)!;
  cycle.child.project.graphs[cycle.child.project.metadata.mainGraphId!]!.nodes.push(call);
  cycle.child.projectContents = serializeProject(cycle.child.project) as string;
  await assert.rejects(collect(cycle), /dependency cycle/);

  // Include same-project edges: A/main → B/main → B/helper → A/main is recursive too.
  const indirect = projectBundleFixture();
  const helperId = 'child-helper' as GraphId;
  const helperGraph = structuredClone(indirect.child.project.graphs[indirect.child.project.metadata.mainGraphId!]!);
  helperGraph.metadata!.id = helperId;
  const localCall = SubGraphNodeImpl.create();
  localCall.data.graphId = helperId;
  indirect.child.project.graphs[indirect.child.project.metadata.mainGraphId!]!.nodes.push(localCall);
  const backToRoot = structuredClone(call);
  backToRoot.data.targetBoundary = getGraphBoundary(indirect.root.project, backToRoot.data.graphId)!;
  helperGraph.nodes.push(backToRoot);
  indirect.child.project.graphs[helperId] = helperGraph;
  indirect.child.projectContents = serializeProject(indirect.child.project) as string;
  await assert.rejects(collect(indirect), /dependency cycle/);
});

for (const fails of [false, true]) {
  test(`terminal export ${fails ? 'failure' : 'success'} waits for cleanup before acknowledgement`, async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-settlement-'));
    const jobs = new ProjectBundleJobs(temporary);
    let releaseCleanup!: () => void;
    let enteredCleanup!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredCleanup = resolve;
    });
    const remove = fs.rm;
    let blockOnce = true;
    t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (
        blockOnce &&
        String(args[0]).startsWith(temporary + path.sep) &&
        path.basename(String(args[0])) === 'staging'
      ) {
        blockOnce = false;
        enteredCleanup();
        await held;
      }
      return remove(...args);
    });
    try {
      const source = projectBundleFixture().source;
      const started = await jobs.start(
        fails
          ? {
              ...source,
              root: async () => {
                throw new Error('storage failed');
              },
            }
          : source,
        'latest',
      );
      await entered;
      let acknowledged = false;
      const status = jobs.status(started.id).then((value) => {
        acknowledged = true;
        return value;
      });
      const download = jobs.download(started.id).then(
        (value) => {
          value.release();
          return true;
        },
        () => false,
      );
      await assert.rejects(jobs.start(source, 'latest'), /Another project bundle/);
      assert.equal(acknowledged, false, 'cleanup must settle before exposing a terminal status');
      releaseCleanup();
      assert.equal((await status).phase, fails ? 'failed' : 'ready');
      assert.equal(await download, !fails);
      const retry = await jobs.start(source, 'latest');
      await jobs.cancel(retry.id);
    } finally {
      releaseCleanup();
      await jobs.dispose();
      t.mock.restoreAll();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
}

test('failed storage does not publish partial archives or expose raw exception secrets', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-failure-'));
  const jobs = new ProjectBundleJobs(temporary);
  try {
    const f = projectBundleFixture();
    const started = await jobs.start(
      {
        ...f.source,
        root: async () => {
          // A storage exception can mimic a formerly whitelisted domain prefix.
          throw new Error('Subgraph password=PRIVATE_TEST_SENTINEL');
        },
      },
      'latest',
    );
    let status = await jobs.status(started.id);
    for (let attempt = 0; attempt < 100 && status.phase === 'collecting'; attempt++) {
      await delay(10);
      status = await jobs.status(started.id);
    }
    assert.equal(status.phase, 'failed');
    assert.ok(!JSON.stringify(status).includes('PRIVATE_TEST_SENTINEL'));
    await assert.rejects(jobs.download(started.id), /not ready/);
    await assert.rejects(fs.stat(path.join(temporary, started.id, 'bundle.zip')), { code: 'ENOENT' });
    const retry = await jobs.start(projectBundleFixture().source, 'latest');
    let retried = await jobs.status(retry.id);
    for (let attempt = 0; attempt < 200 && ['collecting', 'packaging'].includes(retried.phase); attempt++) {
      await delay(10);
      retried = await jobs.status(retry.id);
    }
    assert.equal(retried.phase, 'ready', 'a failed job must not poison a later export');
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('scratch budget failure is actionable and never publishes an archive', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-budget-'));
  const jobs = new ProjectBundleJobs(temporary);
  try {
    await withEnvOverride('RIVET_PROJECT_BUNDLE_SCRATCH_MAX_BYTES', '1', async () => {
      const started = await jobs.start(projectBundleFixture().source, 'latest');
      let status = await jobs.status(started.id);
      for (let attempt = 0; attempt < 100 && status.phase === 'collecting'; attempt++) {
        await delay(10);
        status = await jobs.status(started.id);
      }
      assert.equal(status.phase, 'failed');
      assert.match(status.error!, /scratch budget/);
      await assert.rejects(jobs.download(started.id), /not ready/);
    });
  } finally {
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('scratch budget counts each staged file before writing the next file of the same artifact', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-file-budget-'));
  const jobs = new ProjectBundleJobs(temporary);
  const f = projectBundleFixture();
  const graph = f.root.project.graphs[f.root.project.metadata.mainGraphId!]!;
  graph.nodes = graph.nodes.filter((node) => node.type !== 'subGraph');
  graph.connections = [];
  f.root.projectContents = serializeProject(f.root.project) as string;
  f.root.datasetsContents = '[]' + ' '.repeat(16 * 1024);
  const projectBytes = Buffer.byteLength(f.root.projectContents);
  const datasetBytes = Buffer.byteLength(f.root.datasetsContents);
  const limit = 2 * Math.max(projectBytes, datasetBytes) + Math.min(projectBytes, datasetBytes);
  const originalWrite = fs.writeFile;
  let datasetWritten = false;
  try {
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith('.rivet-data')) datasetWritten = true;
      return originalWrite(...args);
    });
    await withEnvOverride('RIVET_PROJECT_BUNDLE_SCRATCH_MAX_BYTES', String(limit), async () => {
      const started = await jobs.start(f.source, 'latest');
      let status = await jobs.status(started.id);
      for (let attempt = 0; attempt < 200 && ['collecting', 'packaging'].includes(status.phase); attempt++) {
        await delay(10);
        status = await jobs.status(started.id);
      }
      assert.equal(status.phase, 'failed');
      assert.match(status.error!, /scratch budget/);
      assert.equal(datasetWritten, false, 'reject before the next file exceeds the reserved staging/archive budget');
    });
  } finally {
    t.mock.restoreAll();
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('failed archive removal stays blocking until all owned scratch can be removed', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-partial-removal-'));
  const jobs = new ProjectBundleJobs(temporary);
  const f = projectBundleFixture();
  const originalRename = fs.rename;
  const originalRm = fs.rm;
  let enteredRemoval!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredRemoval = resolve;
  });
  let releaseRemoval!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  let id: string | undefined;
  let failRemoval = true;
  try {
    // Fail publication after ZIP construction, leaving a real partial archive.
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[0]).endsWith('bundle.partial'))
        throw Object.assign(new Error('Owned publish fault'), { code: 'EIO' });
      return originalRename(...args);
    });
    t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).endsWith('bundle.partial')) {
        enteredRemoval();
        await held;
        if (failRemoval) throw Object.assign(new Error('Owned partial removal fault'), { code: 'EACCES' });
      }
      if (id && args[0] === path.join(temporary, id) && failRemoval)
        throw Object.assign(new Error('Owned directory removal fault'), { code: 'EACCES' });
      return originalRm(...args);
    });
    const started = await jobs.start(f.source, 'latest');
    id = started.id;
    await entered;
    releaseRemoval();
    // Wait until preparation/final staging cleanup settles without expiring the failed job.
    await jobs.dispose();
    assert.ok((await fs.stat(path.join(temporary, id, 'bundle.partial'))).size > 0);
    const restarted = new ProjectBundleJobs(temporary);
    try {
      await assert.rejects(restarted.start(f.source, 'latest'), { code: 'EACCES' });
    } finally {
      await restarted.dispose();
    }
    // The current owner must remember cleanup failure too, before a restart.
    await assert.rejects(jobs.cleanup(), { code: 'EACCES' });
    failRemoval = false;
    t.mock.restoreAll();
    await jobs.cleanup();
    await assert.rejects(fs.stat(path.join(temporary, id)), { code: 'ENOENT' });
  } finally {
    releaseRemoval();
    t.mock.restoreAll();
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('failed start rollback retains directory ownership and recovers after removal succeeds', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-export-start-rollback-'));
  const jobs = new ProjectBundleJobs(temporary);
  const id = randomUUID();
  const directory = path.join(temporary, id);
  const originalWrite = fs.writeFile;
  const originalRm = fs.rm;
  let firstJournal = true;
  try {
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (path.dirname(String(args[0])) === directory && firstJournal) {
        firstJournal = false;
        throw Object.assign(new Error('Owned journal fault'), { code: 'ENOSPC' });
      }
      return originalWrite(...args);
    });
    t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === directory) throw Object.assign(new Error('Owned rollback fault'), { code: 'EACCES' });
      return originalRm(...args);
    });
    await assert.rejects(jobs.start(projectBundleFixture().source, 'latest', id), { code: 'ENOSPC' });
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8')).phase, 'failed');
    await assert.rejects(jobs.start(projectBundleFixture().source, 'latest'), { code: 'EACCES' });
    t.mock.restoreAll();
    await jobs.cleanup();
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    const next = await jobs.start(projectBundleFixture().source, 'latest', id);
    await jobs.cancel(next.id);
  } finally {
    t.mock.restoreAll();
    await jobs.dispose();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('filesystem saved export HTTP requires auth and supports exact Range/If-Range resumption', async () => {
  const suite = await createFilesystemWorkflowSuiteHarness();
  const f = projectBundleFixture();
  let id: string | undefined;
  try {
    await suite.resetAndEnsureWorkflowsRoot();
    await fs.writeFile(path.join(suite.workflowsRoot, 'root.rivet-project'), f.root.projectContents);
    await fs.writeFile(path.join(suite.workflowsRoot, 'child.rivet-project'), f.child.projectContents);
    const captured = await createSavedBundleSource('root.rivet-project', 'live').root();
    assert.equal(captured.project.metadata.id, f.root.project.metadata.id);
    await withEnvOverride('RIVET_KEY', 'bundle-fixture-key-not-a-real-secret', async () => {
      await suite.withWorkflowApiServer(async (base) => {
        const url = `${base}/project-bundles`;
        assert.equal(
          (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ relativePath: 'root.rivet-project', version: 'live' }),
            })
          ).status,
          403,
        );
        const headers = { 'Content-Type': 'application/json', 'x-rivet-proxy-auth': getExpectedProxyAuthToken() };
        const started = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ relativePath: 'root.rivet-project', version: 'live' }),
        });
        assert.equal(started.status, 202);
        id = ((await started.json()) as { id: string }).id;
        let status = await projectBundleJobs.status(id);
        for (let attempt = 0; attempt < 200 && ['collecting', 'packaging'].includes(status.phase); attempt++) {
          await delay(10);
          status = await projectBundleJobs.status(id);
        }
        assert.equal(status.phase, 'ready', JSON.stringify(status));
        const full = await fetch(`${url}/${id}/download`, { headers });
        assert.equal(full.status, 200);
        const bytes = Buffer.from(await full.arrayBuffer()),
          etag = full.headers.get('etag')!;
        const range = await fetch(`${url}/${id}/download`, {
          headers: { ...headers, Range: 'bytes=0-31', 'If-Range': etag },
        });
        assert.equal(range.status, 206);
        assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 32));
        assert.equal(range.headers.get('content-range'), `bytes 0-31/${bytes.length}`);
        const stale = await fetch(`${url}/${id}/download`, {
          headers: { ...headers, Range: 'bytes=0-31', 'If-Range': '"old"' },
        });
        assert.equal(stale.status, 200);
        await stale.arrayBuffer();
        assert.equal((await fetch(`${url}/${id}/download`)).status, 403);
      });
    });
  } finally {
    if (id) await projectBundleJobs.cancel(id);
    await suite.cleanupWorkflowSuite();
  }
});
