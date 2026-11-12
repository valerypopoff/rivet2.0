import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { deserializeProject, serializeProject, type Project, type ProjectId } from '@valerypopoff/rivet2-core';
import { createEditorBundleComparison } from '../dashboard/editorBundleComparison';
import type { EditorCommandBridgeContext } from '../dashboard/editorCommandBridgeContext';
import type { RivetProjectCompareState, RivetProjectCompareOptions } from '../../app/src/host';
import type {
  BundleComparisonCommand,
  BundleComparisonIntent,
  BundleComparisonOwner,
} from '../../studio-server-shared/workflow-bundle-comparison-types';

class ParseWorker extends EventTarget {
  postMessage(request: { id: string; type: string; data: { serializedProject: string } }) {
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: request.id,
            type: `${request.type}:result`,
            result: deserializeProject(request.data.serializedProject)[0],
          },
        }),
      ),
    );
  }
  terminate() {}
}
const reference = { metadata: { id: 'old', title: 'Old' }, graphs: {} } as Project;
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const messages: { requestId?: string; state?: { error?: string; cancelled?: true } }[] = [];
  for (const [key, value] of Object.entries({
    window: {
      location: { origin: 'http://fixture', href: 'http://fixture/editor' },
      parent: { postMessage: (message: unknown) => messages.push(message as never) },
      frameElement: null,
    },
    HTMLIFrameElement: class {},
    Worker: ParseWorker,
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const state: RivetProjectCompareState = {
    owner: null,
    projectId: 'new' as ProjectId,
    referenceProjectId: null,
    referenceId: null,
    graphId: null,
    activationRevision: 0,
  };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const opened: Record<string, { projectId: string; fsPath: string; title: string }> = {
    new: { projectId: 'new', fsPath: '/new', title: 'New' },
  };
  let activations = 0,
    stops = 0;
  let release: () => void = () => {};
  let blocked: Promise<void> | undefined;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (blocked)
      await new Promise<void>((resolve, reject) => {
        blocked!.then(resolve, reject);
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      });
    options?.signal?.throwIfAborted();
    const body = JSON.parse(options?.body as string);
    return Response.json({
      older: body.older ? { ...body.older, contents: serializeProject(reference) } : null,
      newer: body.newer ? { ...body.newer, path: '/new' } : null,
    });
  });
  const workspace = {
    getProjectCompareState: () => state,
    subscribeProjectCompare: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateProjectCompareDefinitions: () => true,
    updateProjectMetadata: async () => true,
    startProjectCompare: async (
      _reference: Project,
      _path: string,
      options: RivetProjectCompareOptions & { owner: BundleComparisonOwner },
    ) => {
      if (state.projectId !== options.expectedProjectId) return false;
      state.owner = options.owner;
      state.referenceProjectId = state.projectId;
      state.referenceId = 'reference-' + options.owner.generation;
      emit();
      return true;
    },
    stopProjectCompare: async (_project: ProjectId | undefined, owner: BundleComparisonOwner) => {
      assert.deepEqual(owner, state.owner);
      stops++;
      state.owner = null;
      state.referenceId = null;
      state.referenceProjectId = null;
      emit();
      return true;
    },
    closeProject: async () => true,
  };
  const context = {
    getWorkspace: () => workspace,
    getProjects: () => ({ openedProjects: opened, openedProjectsSortedIds: ['new'] }),
    getLoadedProject: () => ({ path: '/new' }),
    getCurrentProject: () => ({ metadata: { id: 'new' } }),
    getOpenProject: () => async () => {
      activations++;
      state.activationRevision++;
      emit();
      return { opened: true, projectId: 'new' };
    },
    preview: { previewProjectRef: { current: null }, promotePreviewProjectByPath: () => {} },
    clearLoadedRecordingForPath: () => {},
    openedProjectPathAliases: new Map(),
  } as unknown as EditorCommandBridgeContext;
  const owner = createEditorBundleComparison(context);
  t.after(() => owner.dispose());
  const intent: BundleComparisonIntent = {
    sessionId: 'session',
    generation: 1,
    pair: {
      older: { bundleId: 'older', projectId: 'old', revisionId: 'pinned' },
      newer: { bundleId: 'newer', projectId: 'new' },
    },
    pairs: [{ olderId: 'old', newerId: 'new' }],
    labels: { referenceLabel: 'Older', currentLabel: 'Newer' },
    referenceCatalog: {
      bundleId: 'older',
      name: 'Older',
      relativePath: 'Older',
      folders: [],
      projects: [
        {
          projectId: 'old',
          name: 'Old',
          relativePath: 'Old.rivet-project',
          revisionId: 'pinned',
          publishedRevisionId: null,
        },
      ],
    },
  };
  const command = (generation = 1): BundleComparisonCommand => ({
    type: 'bundle-comparison',
    requestId: `open-${generation}`,
    action: 'open',
    intent: { ...structuredClone(intent), generation },
  });
  return {
    state,
    messages,
    emit,
    owner,
    context,
    opened,
    command,
    activations: () => activations,
    stops: () => stops,
    run: async (command: BundleComparisonCommand) => {
      owner.admit(command);
      await owner.run(command);
    },
    block: () => {
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      blocked = undefined;
      release();
    },
  };
}
async function openInspection(f: ReturnType<typeof fixture>) {
  f.context.getWorkspace().openProjectSnapshot = async ({ project, path }) => {
    f.state.projectId = project.metadata.id;
    f.opened[project.metadata.id] = { projectId: project.metadata.id, fsPath: path ?? '', title: 'Inspection' };
    f.emit();
    return true;
  };
  const command = f.command();
  if (command.action !== 'open') throw new Error('Expected open command');
  command.intent.pair.newer = null;
  command.intent.pairs = [{ olderId: 'old', newerId: null }];
  await f.run(command);
  assert.ok(f.state.projectId?.startsWith('bundle-comparison:'));
  return f.state.projectId!;
}
const stopCommand = (generation: number): BundleComparisonCommand => ({
  type: 'bundle-comparison',
  requestId: `stop-${generation}`,
  action: 'stop',
  owner: { sessionId: 'session', generation },
});
void test('stale Exit cannot clear a newer pair or a standalone comparison on the same project', async (t) => {
  const f = fixture(t);
  await f.run(f.command(1));
  await f.run(f.command(3));
  assert.deepEqual(f.state.owner, { sessionId: 'session', generation: 3 });
  await f.run({
    type: 'bundle-comparison',
    requestId: 'old-stop',
    action: 'stop',
    owner: { sessionId: 'session', generation: 2 },
  });
  assert.equal(f.stops(), 0);
  f.state.owner = null;
  f.state.referenceId = 'standalone';
  f.emit();
  await f.run({
    type: 'bundle-comparison',
    requestId: 'new-stop',
    action: 'stop',
    owner: { sessionId: 'session', generation: 4 },
  });
  assert.equal(f.stops(), 0);
  assert.equal(f.state.referenceId, 'standalone');
});
void test('native navigation cancels a pending read before any project activation and acknowledges cancellation', async (t) => {
  const f = fixture(t);
  f.block();
  const pending = f.run(f.command());
  f.state.activationRevision++;
  f.state.projectId = 'other' as ProjectId;
  f.emit();
  await pending;
  f.release();
  assert.equal(f.activations(), 0);
  assert.equal(f.state.owner, null);
  assert.match(f.messages.findLast((m) => m.requestId === 'open-1')?.state?.error ?? '', /selection changed/i);
  assert.equal(f.messages.findLast((m) => m.requestId === 'open-1')?.state?.cancelled, true);
});
void test('a queued normal project open can cancel a comparison read without waiting behind it', async (t) => {
  const f = fixture(t);
  f.block();
  const pending = f.run(f.command());
  f.owner.cancelPending();
  await pending;
  f.release();
  assert.equal(f.activations(), 0);
  assert.equal(f.messages.findLast((m) => m.requestId === 'open-1')?.state?.cancelled, true);
});
void test(
  'a standalone comparison started during Newer activation supersedes the pending bundle attachment',
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const gate = deferred();
    t.after(gate.resolve);
    t.mock.method(f.context, 'getOpenProject', () => async () => {
      entered.resolve();
      await gate.promise;
      return { opened: true, projectId: 'new' as ProjectId };
    });
    const pending = f.run(f.command());
    await entered.promise;
    f.state.owner = null;
    f.state.referenceProjectId = 'new' as ProjectId;
    f.state.referenceId = 'standalone';
    f.emit();
    gate.resolve();
    await pending;
    assert.equal(f.state.owner, null);
    assert.equal(f.state.referenceId, 'standalone');
    assert.equal(f.messages.findLast((m) => m.requestId === 'open-1')?.state?.cancelled, true);
  },
);
void test(
  'cancelling Older-only activation cannot close a document claimed by a standalone comparison',
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const gate = deferred();
    t.after(gate.resolve);
    const workspace = f.context.getWorkspace();
    workspace.openProjectSnapshot = async ({ project }) => {
      f.state.projectId = project.metadata.id;
      entered.resolve();
      await gate.promise;
      return true;
    };
    const closed: ProjectId[] = [];
    t.mock.method(workspace, 'closeProject', async (id) => {
      closed.push(id);
      return true;
    });
    const command = f.command();
    if (command.action !== 'open') throw new Error('Expected open command');
    command.intent.pair.newer = null;
    command.intent.pairs = [{ olderId: 'old', newerId: null }];
    const pending = f.run(command);
    await entered.promise;
    f.state.owner = null;
    f.state.referenceProjectId = f.state.projectId;
    f.state.referenceId = 'standalone';
    f.emit();
    gate.resolve();
    await pending;
    assert.equal(f.state.owner, null);
    assert.equal(f.state.referenceId, 'standalone');
    assert.deepEqual(closed, []);
  },
);
void test('a superseded read is not replayed and a stale stop does not abort the newer pending open', async (t) => {
  const f = fixture(t);
  f.block();
  const obsolete = f.run(f.command(1));
  const next = f.command(3);
  f.owner.admit(next);
  await obsolete;
  const current = f.owner.run(next);
  await f.run({
    type: 'bundle-comparison',
    requestId: 'old-exit',
    action: 'stop',
    owner: { sessionId: 'session', generation: 2 },
  });
  f.release();
  await current;
  assert.equal(f.activations(), 1);
  assert.deepEqual(f.state.owner, { sessionId: 'session', generation: 3 });
});
void test(
  'cancelled metadata completion cannot close an inspection claimed by a later native comparison',
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(t);
    const workspace = f.context.getWorkspace();
    workspace.openProjectSnapshot = async ({ project }) => {
      f.state.projectId = project.metadata.id;
      return true;
    };
    const inspection = f.command();
    if (inspection.action !== 'open') throw new Error('Expected open command');
    inspection.intent.pair.newer = null;
    inspection.intent.pairs = [{ olderId: 'old', newerId: null }];
    await f.run(inspection);
    const inspectionId = f.state.projectId;
    t.mock.method(f.context, 'getOpenProject', () => async () => {
      f.state.projectId = 'new' as ProjectId;
      f.state.activationRevision++;
      f.emit();
      return { opened: true, projectId: 'new' as ProjectId };
    });
    const entered = deferred();
    const gate = deferred();
    t.after(gate.resolve);
    t.mock.method(workspace, 'updateProjectMetadata', async () => {
      entered.resolve();
      await gate.promise;
      return true;
    });
    const closed: ProjectId[] = [];
    t.mock.method(workspace, 'closeProject', async (id) => {
      closed.push(id);
      return true;
    });
    const pending = f.run(f.command(3));
    await entered.promise;
    f.state.projectId = inspectionId;
    f.state.activationRevision++;
    f.state.owner = null;
    f.state.referenceProjectId = inspectionId;
    f.state.referenceId = 'standalone';
    f.emit();
    gate.resolve();
    await pending;
    assert.deepEqual(closed, []);
    assert.equal(f.state.referenceId, 'standalone');
    assert.equal(f.state.owner, null);
    assert.equal(f.messages.findLast((m) => m.requestId === 'open-3')?.state?.cancelled, true);
  },
);
void test('a rejected metadata update does not attach a comparison to an unverified binding', async (t) => {
  const f = fixture(t);
  t.mock.method(f.context.getWorkspace(), 'updateProjectMetadata', async () => false);
  await f.run(f.command());
  assert.equal(f.state.owner, null);
  assert.match(f.messages.findLast((m) => m.requestId === 'open-1')?.state?.error ?? '', /binding.*updated/i);
});
void test('Exit preserves the replacement selected by the normal close operation', async (t) => {
  const f = fixture(t);
  const inspectionId = await openInspection(f);
  const workspace = f.context.getWorkspace();
  const forcedActivations: ProjectId[] = [];
  workspace.activateProject = async (id) => {
    forcedActivations.push(id);
    f.state.projectId = id;
    return true;
  };
  t.mock.method(workspace, 'closeProject', async (id) => {
    delete f.opened[id!];
    f.state.projectId = 'user-selection' as ProjectId;
    f.state.activationRevision++;
    f.emit();
    return true;
  });
  await f.run(stopCommand(2));
  assert.equal(f.state.projectId, 'user-selection');
  assert.deepEqual(forcedActivations, []);
  assert.equal(f.opened[inspectionId], undefined);
});
void test('a rejected inspection close is reported and retained for a later explicit close', async (t) => {
  const f = fixture(t);
  const inspectionId = await openInspection(f);
  const workspace = f.context.getWorkspace();
  workspace.activateProject = async () => true;
  let closes = 0;
  t.mock.method(workspace, 'closeProject', async (id) => {
    if (++closes === 1) return false;
    delete f.opened[id!];
    f.state.projectId = 'new' as ProjectId;
    return true;
  });
  await f.run(stopCommand(2));
  assert.equal(closes, 1);
  assert.ok(f.opened[inspectionId]);
  assert.match(
    f.messages.findLast((message) => message.requestId === 'stop-2')?.state?.error ?? '',
    /inspection could not be closed/i,
  );
  await f.run(stopCommand(3));
  assert.equal(closes, 2);
  assert.equal(f.opened[inspectionId], undefined);
});
void test('a native takeover during Stop prevents subsequent inspection cleanup', { timeout: 5_000 }, async (t) => {
  const f = fixture(t);
  const inspectionId = await openInspection(f);
  const workspace = f.context.getWorkspace();
  workspace.activateProject = async () => true;
  const entered = deferred();
  const gate = deferred();
  t.after(gate.resolve);
  t.mock.method(workspace, 'stopProjectCompare', async () => {
    entered.resolve();
    await gate.promise;
    return false;
  });
  const closed: ProjectId[] = [];
  t.mock.method(workspace, 'closeProject', async (id) => {
    closed.push(id!);
    return true;
  });
  const pending = f.run(stopCommand(2));
  await entered.promise;
  f.state.owner = null;
  f.state.referenceProjectId = inspectionId;
  f.state.referenceId = 'standalone';
  f.emit();
  gate.resolve();
  await pending;
  assert.deepEqual(closed, []);
  assert.equal(f.state.referenceId, 'standalone');
});
