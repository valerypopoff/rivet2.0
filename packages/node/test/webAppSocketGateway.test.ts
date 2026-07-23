import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import WebSocket from 'ws';
import {
  ExecutionRecorder,
  type GraphProcessor,
  createInMemoryRivetWebAppRunCoordinator,
  createInMemoryRivetWebAppRunStore,
  createRivetWebAppWebSocketGateway,
  type Project,
  type RivetKnowledgeStore,
  type RivetWebAppServerMessage,
} from '../src/index.js';
import {
  makeExternalStatusProject,
  makeKnowledgeStatusProject,
  makeStoredValueProject,
  makeWebAppProject,
} from './webAppFixtures.js';
import {
  closeWebAppTestHarnesses,
  collectWebAppSocketMessages as collectMessages,
  createWebAppSocketHarness as createHarness,
  makeWebAppStartMessage as makeStartMessage,
  trackWebAppTestSocket,
  waitForWebAppSocketClose as waitForClose,
} from './webAppTestHarness.js';
const TEST_LEASE_ID = 'test-lease';

function activeLease(leaseId = TEST_LEASE_ID, leaseDurationMs = 60_000) {
  return { leaseDurationMs, leaseId };
}

afterEach(closeWebAppTestHarnesses);

void describe('Rivet web app WebSocket gateway', () => {
  void it('rejects unsafe resource-limit and host identity configuration', () => {
    assert.throws(() => createInMemoryRivetWebAppRunStore({ maxEventsPerRun: 1 }), /maxEventsPerRun/);
    assert.throws(() => createInMemoryRivetWebAppRunStore({ maxStoredRuns: 0 }), /maxStoredRuns/);
    assert.throws(() => createRivetWebAppWebSocketGateway({ hostId: '  ' }), /hostId cannot be blank/);
    assert.throws(() => createRivetWebAppWebSocketGateway({ maxMessageBytes: Number.NaN }), /maxMessageBytes/);
  });

  void it('requires the version handshake before accepting action messages', async () => {
    const harness = await createHarness(makeProject());
    const client = await harness.connect('owner', false);

    client.send(JSON.stringify(makeStartMessage('request-without-handshake')));
    const close = await waitForClose(client);

    assert.equal(close.code, 1002);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('acknowledges the connection only after validating the client handshake', async () => {
    const harness = await createHarness(makeProject());
    const client = await harness.connect('owner', false);
    const messages = collectMessages(client);

    client.send(JSON.stringify({ type: 'client.hello', protocolVersion: 1 }));
    const ready = await messages.next('server.ready');

    assert.equal(ready.protocolVersion, 1);
  });

  void it('closes clients that never complete the protocol handshake', async () => {
    const harness = await createHarness(makeProject(), undefined, { handshakeTimeoutMs: 10 });
    const client = await harness.connect('owner', false);

    const close = await waitForClose(client);

    assert.equal(close.code, 1002);
    assert.match(close.reason.toString(), /handshake timed out/);
  });

  void it('streams progress and completion, then replays the same idempotent run', async () => {
    const project = makeProject();
    let starts = 0;
    const harness = await createHarness(project, () => {
      starts += 1;
    });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-1')));
    const accepted = await messages.next('action.accepted');
    const progress = await messages.next('action.progress');
    const completed = await messages.next('action.completed');

    assert.equal(progress.runId, accepted.runId);
    assert.deepEqual(progress.progress, { message: 'Preparing response', percent: 40 });
    assert.deepEqual(completed.statePatch, { result: 'Hello' });
    assert.equal(starts, 1);

    client.send(JSON.stringify(makeStartMessage('request-1')));
    const replayedAccepted = await messages.next('action.accepted');
    await messages.next('action.progress');
    const replayedCompleted = await messages.next('action.completed');

    assert.equal(replayedAccepted.runId, accepted.runId);
    assert.equal(replayedCompleted.runId, accepted.runId);
    assert.equal(starts, 1);
  });

  void it('streams status messages sent by the setWebAppStatus external call', async () => {
    const harness = await createHarness(makeExternalStatusProject());
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-status')));
    await messages.next('action.accepted');
    const progress = await messages.next('action.progress');
    const completed = await messages.next('action.completed');

    assert.deepEqual(progress.progress, { message: 'Hello' });
    assert.deepEqual(completed.statePatch, { result: 'Hello' });
  });

  void it('publishes foreground outputs before releasing an active async run slot', async () => {
    const project = makeWebAppProject();
    project.graphs[project.metadata.mainGraphId]!.nodes.push(
      {
        data: {},
        id: 'async-trigger' as never,
        title: 'Start Async Branch',
        type: 'startBackgroundBranch',
        visualData: { x: 200, y: 120 },
      } as never,
      {
        data: { functionName: 'waitForRelease', useErrorOutput: false, useFunctionNameInput: false },
        id: 'async-call' as never,
        title: 'Async side effect',
        type: 'externalCall',
        visualData: { x: 400, y: 120 },
      } as never,
    );
    project.graphs[project.metadata.mainGraphId]!.connections.push(
      {
        inputId: 'input1' as never,
        inputNodeId: 'async-trigger' as never,
        outputId: 'data' as never,
        outputNodeId: 'input-node' as never,
      },
      {
        inputId: 'arguments' as never,
        inputNodeId: 'async-call' as never,
        outputId: 'output1' as never,
        outputNodeId: 'async-trigger' as never,
      },
    );
    let releaseBranch!: () => void;
    let reportBranchStarted!: () => void;
    const branchRelease = new Promise<void>((resolve) => {
      releaseBranch = resolve;
    });
    const branchStarted = new Promise<void>((resolve) => {
      reportBranchStarted = resolve;
    });
    const baseRunStore = createInMemoryRivetWebAppRunStore();
    let completedRunId: string | undefined;
    let settleLeasePass!: (error?: Error) => void;
    const postCompletionLeasePass = new Promise<void>((resolve, reject) => {
      settleLeasePass = (error) => (error ? reject(error) : resolve());
    });
    let leasePassObserved = false;
    const runStore = {
      ...baseRunStore,
      async renewRunLeases(...args: Parameters<typeof baseRunStore.renewRunLeases>) {
        const terminalRunIdAtStart = completedRunId;
        const renewed = await baseRunStore.renewRunLeases(...args);
        if (terminalRunIdAtStart && !leasePassObserved) {
          leasePassObserved = true;
          settleLeasePass(
            args[1].includes(terminalRunIdAtStart)
              ? new Error('A terminal run was still submitted for lease renewal.')
              : undefined,
          );
        }
        return renewed;
      },
    };
    let processor: GraphProcessor | undefined;
    let runFinished = false;
    const harness = await createHarness(
      project,
      undefined,
      { leaseDurationMs: 30, leaseRenewIntervalMs: 5, runStore },
      {
        createProcessorOptions: {
          externalFunctions: {
            waitForRelease: async (value) => {
              reportBranchStarted();
              await branchRelease;
              return value;
            },
          },
        },
        onProcessorPrepared(context) {
          processor = context.processor;
        },
        onRunFinished() {
          runFinished = true;
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-async-result')));
    await messages.next('action.accepted');
    await branchStarted;
    const completed = await messages.next('action.completed');
    completedRunId = completed.runId;

    assert.deepEqual(completed.statePatch, { result: 'Hello' });
    assert.equal(processor?.isRunning, true);
    assert.equal(harness.gateway.getActiveRunCount(), 1);
    assert.equal(runFinished, false);

    await Promise.race([
      postCompletionLeasePass,
      delay(1_000).then(() => {
        throw new Error('Timed out waiting for the post-completion lease pass.');
      }),
    ]);
    assert.equal(processor?.isRunning, true);
    assert.equal(harness.gateway.getActiveRunCount(), 1);

    releaseBranch();
    await processor?.waitForRunCompletion();
    await delay(0);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
    assert.equal(runFinished, true);
  });

  void it('returns web-app storage changes through replayable WebSocket completion events', async () => {
    const harness = await createHarness(makeStoredValueProject('set'));
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(
      JSON.stringify({
        ...makeStartMessage('request-storage'),
        state: { prompt: 'Updated summary' },
        storage: { analysis: 'Old summary' },
      }),
    );
    await messages.next('action.accepted');
    const completed = await messages.next('action.completed');

    assert.deepEqual(completed.storagePatch, { analysis: 'Updated summary' });
  });

  void it('uses a session Stored Value store instead of the WebSocket browser snapshot', async () => {
    const harness = await createHarness(
      makeStoredValueProject('get'),
      undefined,
      {},
      {
        storedValueStore: { get: () => 'Host summary', set() {} },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(
      JSON.stringify({
        ...makeStartMessage('request-host-storage'),
        storage: { analysis: 'Browser summary' },
      }),
    );
    await messages.next('action.accepted');
    const completed = await messages.next('action.completed');

    assert.deepEqual(completed.statePatch, { result: 'Host summary' });
    assert.deepEqual(completed.storagePatch, {});
  });

  void it('uses a session knowledge-store registry for WebSocket actions', async () => {
    const store: RivetKnowledgeStore = {
      capabilities: {},
      async getSourceStatus({ source }) {
        return { exists: true, source, activeVersion: 'v1', message: 'WebSocket store' };
      },
      async syncSource() {
        throw new Error('not used');
      },
      async search() {
        throw new Error('not used');
      },
    };
    const harness = await createHarness(
      makeKnowledgeStatusProject(),
      undefined,
      {},
      { knowledgeStores: { primary: store } },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-knowledge-store')));
    await messages.next('action.accepted');
    const completed = await messages.next('action.completed');

    assert.deepEqual(completed.statePatch, { result: 'WebSocket store' });
  });

  void it('exposes the prepared processor before execution so hosts can attach complete recordings', async () => {
    const lifecycle: string[] = [];
    let recorder!: ExecutionRecorder;
    let preparedRunId: string | undefined;
    let preparedRequestId: string | undefined;
    const harness = await createHarness(
      makeProject(),
      () => lifecycle.push('action-start'),
      {},
      {
        async onProcessorPrepared({ actionContext, processor, requestId, runId }) {
          await delay(10);
          recorder = new ExecutionRecorder({ includePartialOutputs: true });
          recorder.record(processor);
          preparedRequestId = requestId;
          preparedRunId = runId;
          lifecycle.push(`prepared:${actionContext.componentId}`);
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-recorded')));
    const accepted = await messages.next('action.accepted');
    await messages.next('action.progress');
    await messages.next('action.completed');

    assert.equal(preparedRequestId, 'request-recorded');
    assert.equal(preparedRunId, accepted.runId);
    assert.deepEqual(lifecycle, ['prepared:run-button', 'action-start']);
    assert.ok(recorder.events.some((event) => event.type === 'graphStart'));
    assert.ok(recorder.events.some((event) => event.type === 'nodeStart'));
    assert.ok(recorder.events.some((event) => event.type === 'nodeFinish'));
    assert.ok(recorder.events.some((event) => event.type === 'graphFinish'));
  });

  void it('reports terminal callbacks with the exact prepared run identity for concurrent actions', async () => {
    const preparedRequestByRun = new Map<string, string>();
    const finished: Array<{ requestId: string; runId: string; result: unknown }> = [];
    const failed: Array<{ outcome: string; requestId: string; runId: string }> = [];
    const harness = await createHarness(
      makeProject(100),
      undefined,
      {},
      {
        onProcessorPrepared({ requestId, runId }) {
          preparedRequestByRun.set(runId, requestId);
        },
        onRunFailed({ outcome, requestId, runId }) {
          failed.push({ outcome, requestId, runId });
        },
        onRunFinished({ requestId, result, runId }) {
          finished.push({ requestId, result, runId });
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    for (const requestId of ['request-first', 'request-second', 'request-cancelled']) {
      client.send(JSON.stringify(makeStartMessage(requestId)));
    }
    const accepted = await Promise.all([
      messages.next('action.accepted'),
      messages.next('action.accepted'),
      messages.next('action.accepted'),
    ]);
    const cancelled = accepted.find((event) => event.requestId === 'request-cancelled');
    assert.ok(cancelled);
    client.send(JSON.stringify({ type: 'action.cancel', runId: cancelled.runId }));

    await messages.next('action.cancelled');
    await messages.next('action.completed');
    await messages.next('action.completed');

    assert.deepEqual(
      finished
        .map(({ requestId, result, runId }) => ({
          preparedRequestId: preparedRequestByRun.get(runId),
          requestId,
          statePatch: (result as { statePatch?: unknown }).statePatch,
        }))
        .sort((left, right) => left.requestId.localeCompare(right.requestId)),
      [
        { preparedRequestId: 'request-first', requestId: 'request-first', statePatch: { result: 'Hello' } },
        { preparedRequestId: 'request-second', requestId: 'request-second', statePatch: { result: 'Hello' } },
      ],
    );
    assert.deepEqual(failed, [
      {
        outcome: 'cancelled',
        requestId: 'request-cancelled',
        runId: cancelled.runId,
      },
    ]);
  });

  void it('waits for asynchronous recorder attachment before reporting a pending run cancellation', async () => {
    let finishPreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    let recorderAttached = false;
    let reportTerminal!: () => void;
    const terminalReported = new Promise<void>((resolve) => {
      reportTerminal = resolve;
    });
    const harness = await createHarness(
      makeProject(100),
      undefined,
      {},
      {
        async onProcessorPrepared() {
          await preparationStarted;
          recorderAttached = true;
        },
        onRunFailed({ outcome }) {
          assert.equal(outcome, 'cancelled');
          assert.equal(recorderAttached, true);
          reportTerminal();
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-cancel-during-preparation')));
    const accepted = await messages.next('action.accepted');
    client.send(JSON.stringify({ type: 'action.cancel', runId: accepted.runId }));
    await messages.next('action.cancelled');

    finishPreparation();
    await terminalReported;
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('isolates terminal-hook failures from the stored action outcome', async () => {
    const observedErrors: string[] = [];
    const harness = await createHarness(
      makeProject(),
      undefined,
      {
        onError(error) {
          observedErrors.push(error instanceof Error ? error.message : String(error));
        },
      },
      {
        onRunFinished() {
          throw new Error('Recording persistence failed.');
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-terminal-hook-failure')));
    await messages.next('action.accepted');
    const completed = await messages.next('action.completed');

    assert.equal(completed.requestId, 'request-terminal-hook-failure');
    assert.deepEqual(observedErrors, ['Recording persistence failed.']);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('fails safely before execution when processor preparation instrumentation fails', async () => {
    const observedErrors: string[] = [];
    const failedRuns: Array<{ outcome: string; requestId: string; runId: string }> = [];
    let attachCount = 0;
    let detachCount = 0;
    let starts = 0;
    const harness = await createHarness(
      makeProject(),
      () => {
        starts += 1;
      },
      { onError: (error) => observedErrors.push(error instanceof Error ? error.message : String(error)) },
      {
        createProcessorOptions: {
          remoteDebugger: {
            attach: () => {
              attachCount += 1;
            },
            broadcast: () => undefined,
            detach: () => {
              detachCount += 1;
            },
            off: () => undefined,
            on: () => undefined,
            webSocketServer: {} as never,
          },
        },
        onProcessorPrepared() {
          throw new Error('Recorder setup exposed a private storage path.');
        },
        onRunFailed({ outcome, requestId, runId }) {
          failedRuns.push({ outcome, requestId, runId });
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-recorder-failure')));
    await messages.next('action.accepted');
    const failed = await messages.next('action.failed');
    await delay(0);

    assert.equal(failed.error, 'The web app action could not be started.');
    assert.equal(failed.code, 'action_unavailable');
    assert.deepEqual(observedErrors, ['Recorder setup exposed a private storage path.']);
    assert.equal(attachCount, 1);
    assert.equal(detachCount, 1);
    assert.equal(starts, 0);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
    assert.deepEqual(failedRuns, [
      {
        outcome: 'failed',
        requestId: 'request-recorder-failure',
        runId: failed.runId,
      },
    ]);
  });

  void it('allows an existing idempotent action to reattach while draining but rejects new starts', async () => {
    let starts = 0;
    const harness = await createHarness(makeProject(120), () => {
      starts += 1;
    });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-before-drain')));
    const accepted = await messages.next('action.accepted');
    harness.gateway.drain();

    client.send(JSON.stringify(makeStartMessage('request-before-drain')));
    const replayed = await messages.next('action.accepted');
    client.send(JSON.stringify(makeStartMessage('request-during-drain')));
    const rejected = await messages.next('action.rejected');

    assert.equal(replayed.runId, accepted.runId);
    assert.equal(rejected.error, 'Web app action server is draining.');
    assert.equal(starts, 1);
  });

  void it('does not start an action that loses the race with gateway draining', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const delayedStore = {
      ...baseStore,
      async createRun(...args: Parameters<typeof baseStore.createRun>) {
        createStarted();
        await createGate;
        return baseStore.createRun(...args);
      },
    };
    let starts = 0;
    const harness = await createHarness(
      makeProject(),
      () => {
        starts += 1;
      },
      { runStore: delayedStore },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-racing-drain')));
    await createStartedPromise;
    harness.gateway.drain();
    releaseCreate();
    const rejected = await messages.next('action.rejected');
    const stored = await baseStore.getRunByRequestId('user:project:app:revision', 'request-racing-drain');

    assert.equal(rejected.code, 'server_draining');
    assert.equal(stored?.status, 'interrupted');
    assert.equal(starts, 0);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('waits for an in-flight durable run reservation before interrupting during disposal', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    const delayedStore = {
      ...baseStore,
      async createRun(...args: Parameters<typeof baseStore.createRun>) {
        createStarted();
        await createGate;
        return baseStore.createRun(...args);
      },
    };
    const harness = await createHarness(makeProject(), undefined, { runStore: delayedStore });
    const client = await harness.connect();

    client.send(JSON.stringify(makeStartMessage('request-racing-dispose')));
    await createStartedPromise;
    let disposeSettled = false;
    const disposePromise = harness.gateway.dispose({ interrupt: true }).then(() => {
      disposeSettled = true;
    });
    await delay(0);
    assert.equal(disposeSettled, false);

    releaseCreate();
    await disposePromise;
    const stored = await baseStore.getRunByRequestId('user:project:app:revision', 'request-racing-dispose');
    assert.equal(stored?.status, 'interrupted');
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('awaits an in-flight lease pass without recovering runs after disposal begins', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    let releaseRenewal!: () => void;
    let renewalStarted!: () => void;
    const renewalGate = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const renewalStartedPromise = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let recoveryCalls = 0;
    const delayedStore = {
      ...baseStore,
      async interruptExpiredRuns(...args: Parameters<typeof baseStore.interruptExpiredRuns>) {
        recoveryCalls += 1;
        return baseStore.interruptExpiredRuns(...args);
      },
      async renewRunLeases() {
        renewalStarted();
        await renewalGate;
        return [];
      },
    };
    const gateway = createRivetWebAppWebSocketGateway({ hostId: 'lease-disposal-host', runStore: delayedStore });

    await renewalStartedPromise;
    let disposeSettled = false;
    const disposePromise = gateway.dispose().then(() => {
      disposeSettled = true;
    });
    await delay(0);
    assert.equal(disposeSettled, false);

    releaseRenewal();
    await disposePromise;
    assert.equal(recoveryCalls, 0);
  });

  void it('publishes a drain-race interruption to a client reattached through another gateway', async () => {
    const runStore = createInMemoryRivetWebAppRunStore();
    const baseCoordinator = createInMemoryRivetWebAppRunCoordinator();
    let releaseCreate!: () => void;
    let runCreated!: () => void;
    let remoteSubscribed!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const runCreatedPromise = new Promise<void>((resolve) => {
      runCreated = resolve;
    });
    const remoteSubscribedPromise = new Promise<void>((resolve) => {
      remoteSubscribed = resolve;
    });
    const delayedStore = {
      ...runStore,
      async createRun(...args: Parameters<typeof runStore.createRun>) {
        const result = await runStore.createRun(...args);
        runCreated();
        await createGate;
        return result;
      },
    };
    const coordinator = {
      ...baseCoordinator,
      async subscribe(...args: Parameters<typeof baseCoordinator.subscribe>) {
        const subscription = await baseCoordinator.subscribe(...args);
        remoteSubscribed();
        return subscription;
      },
    };
    const owner = await createHarness(makeProject(), undefined, {
      hostId: 'host-a',
      runCoordinator: coordinator,
      runStore: delayedStore,
    });
    const reconnect = await createHarness(makeProject(), undefined, {
      hostId: 'host-b',
      runCoordinator: coordinator,
      runStore,
    });
    const ownerClient = await owner.connect();
    const ownerMessages = collectMessages(ownerClient);

    ownerClient.send(JSON.stringify(makeStartMessage('request-racing-remote')));
    await runCreatedPromise;

    const reconnectClient = await reconnect.connect();
    const reconnectMessages = collectMessages(reconnectClient);
    reconnectClient.send(JSON.stringify(makeStartMessage('request-racing-remote')));
    await remoteSubscribedPromise;

    owner.gateway.drain();
    releaseCreate();

    const [rejected, interrupted] = await Promise.all([
      ownerMessages.next('action.rejected'),
      reconnectMessages.next('action.interrupted'),
    ]);
    assert.equal(rejected.code, 'server_draining');
    assert.match(interrupted.error, /setup failed/);
    assert.equal((await runStore.getRun(interrupted.runId))?.status, 'interrupted');
  });

  void it('closes the read-subscribe race when an existing run finishes during attachment', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    await baseStore.createRun({
      componentId: 'run-button',
      createdAt: 1,
      hostId: 'stored-host',
      ...activeLease(),
      ownerScope: 'user:project:app:revision',
      requestId: 'request-racing-replay',
      runId: 'stored-run',
    });
    await baseStore.appendEvent('stored-run', TEST_LEASE_ID, {
      type: 'action.accepted',
      requestId: 'request-racing-replay',
      runId: 'stored-run',
    });
    const racingStore = {
      ...baseStore,
      async getRunByRequestId(...args: Parameters<typeof baseStore.getRunByRequestId>) {
        const staleSnapshot = await baseStore.getRunByRequestId(...args);
        await baseStore.appendEvent('stored-run', TEST_LEASE_ID, {
          type: 'action.completed',
          requestId: 'request-racing-replay',
          runId: 'stored-run',
          statePatch: { result: 'Stored result' },
        });
        return staleSnapshot;
      },
    };
    let starts = 0;
    const harness = await createHarness(
      makeProject(),
      () => {
        starts += 1;
      },
      { runStore: racingStore },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-racing-replay')));
    await messages.next('action.accepted');
    const completed = await messages.next('action.completed');

    assert.deepEqual(completed.statePatch, { result: 'Stored result' });
    assert.equal(starts, 0);
  });

  void it('does not read a newly accepted run back from the store before execution', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const writeOnlyStartStore = {
      ...baseStore,
      async getRun() {
        throw new Error('Unexpected run readback.');
      },
    };
    const harness = await createHarness(makeProject(), undefined, { runStore: writeOnlyStartStore });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-no-readback')));
    await messages.next('action.accepted');
    await messages.next('action.progress');
    const completed = await messages.next('action.completed');

    assert.deepEqual(completed.statePatch, { result: 'Hello' });
  });

  void it('rejects reuse of one request ID for a different component', async () => {
    const harness = await createHarness(makeProject());
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-component-conflict')));
    await messages.next('action.accepted');
    await messages.next('action.progress');
    await messages.next('action.completed');
    client.send(
      JSON.stringify({ ...makeStartMessage('request-component-conflict'), componentId: 'another-component' }),
    );
    const rejected = await messages.next('action.rejected');

    assert.equal(rejected.code, 'request_id_conflict');
    assert.match(rejected.error, /already used for another component/);
  });

  void it('keeps a run alive across socket disconnect and resumes from the requested sequence', async () => {
    const project = makeProject(120);
    const harness = await createHarness(project);
    const firstClient = await harness.connect();
    const firstMessages = collectMessages(firstClient);

    firstClient.send(JSON.stringify(makeStartMessage('request-resume')));
    const accepted = await firstMessages.next('action.accepted');
    firstClient.close();
    await waitForClose(firstClient);

    const resumedClient = await harness.connect();
    const resumedMessages = collectMessages(resumedClient);
    resumedClient.send(JSON.stringify({ type: 'run.resume', runId: accepted.runId, lastSequence: 1 }));

    const progress = await resumedMessages.next('action.progress');
    const completed = await resumedMessages.next('action.completed');
    assert.equal(progress.sequence, 2);
    assert.equal(completed.sequence, 3);
    assert.deepEqual(completed.statePatch, { result: 'Hello' });
  });

  void it('resumes a live run through another gateway by coordinating with its owner', async () => {
    const runStore = createInMemoryRivetWebAppRunStore();
    const runCoordinator = createInMemoryRivetWebAppRunCoordinator();
    const owner = await createHarness(makeProject(120), undefined, {
      hostId: 'host-a',
      runCoordinator,
      runStore,
    });
    const reconnect = await createHarness(makeProject(), undefined, {
      hostId: 'host-b',
      runCoordinator,
      runStore,
    });
    const firstClient = await owner.connect();
    const firstMessages = collectMessages(firstClient);

    firstClient.send(JSON.stringify(makeStartMessage('request-cross-host-resume')));
    const accepted = await firstMessages.next('action.accepted');
    firstClient.close();
    await waitForClose(firstClient);

    const resumedClient = await reconnect.connect();
    const resumedMessages = collectMessages(resumedClient);
    resumedClient.send(JSON.stringify({ type: 'run.resume', runId: accepted.runId, lastSequence: 1 }));

    const progress = await resumedMessages.next('action.progress');
    const completed = await resumedMessages.next('action.completed');
    assert.equal(progress.runId, accepted.runId);
    assert.equal(completed.runId, accepted.runId);
    assert.deepEqual(completed.statePatch, { result: 'Hello' });

    await owner.gateway.dispose();
    await reconnect.gateway.dispose();
  });

  void it('fills coordinator sequence gaps from durable storage before forwarding a terminal event', async () => {
    const runStore = createInMemoryRivetWebAppRunStore();
    const runCoordinator = createInMemoryRivetWebAppRunCoordinator();
    await runStore.createRun({
      componentId: 'run-button',
      createdAt: Date.now(),
      hostId: 'host-a',
      ...activeLease(),
      ownerScope: 'user:project:app:revision',
      requestId: 'request-out-of-order',
      runId: 'run-out-of-order',
    });
    const accepted = await runStore.appendEvent('run-out-of-order', TEST_LEASE_ID, {
      type: 'action.accepted',
      requestId: 'request-out-of-order',
      runId: 'run-out-of-order',
    });
    assert.ok(accepted);

    const reconnect = await createHarness(makeProject(), undefined, {
      hostId: 'host-b',
      runCoordinator,
      runStore,
    });
    const client = await reconnect.connect();
    const messages = collectMessages(client);
    client.send(JSON.stringify({ type: 'run.resume', runId: 'run-out-of-order', lastSequence: 0 }));
    await messages.next('action.accepted');

    const progress = await runStore.appendEvent('run-out-of-order', TEST_LEASE_ID, {
      type: 'action.progress',
      progress: { percent: 50 },
      requestId: 'request-out-of-order',
      runId: 'run-out-of-order',
    });
    const completed = await runStore.appendEvent('run-out-of-order', TEST_LEASE_ID, {
      type: 'action.completed',
      requestId: 'request-out-of-order',
      runId: 'run-out-of-order',
      statePatch: { result: 'done' },
    });
    assert.ok(progress);
    assert.ok(completed);

    await runCoordinator.publishEvent({
      event: completed,
      hostId: 'host-a',
      ownerScope: 'user:project:app:revision',
      runId: 'run-out-of-order',
    });
    await runCoordinator.publishEvent({
      event: progress,
      hostId: 'host-a',
      ownerScope: 'user:project:app:revision',
      runId: 'run-out-of-order',
    });

    assert.equal((await messages.next('action.progress')).sequence, 2);
    assert.equal((await messages.next('action.completed')).sequence, 3);
    await reconnect.gateway.dispose();
  });

  void it('forwards cancellation from a reconnecting gateway to the live owner', async () => {
    const runStore = createInMemoryRivetWebAppRunStore();
    const runCoordinator = createInMemoryRivetWebAppRunCoordinator();
    const owner = await createHarness(makeProject(2_000), undefined, {
      hostId: 'host-a',
      runCoordinator,
      runStore,
    });
    const reconnect = await createHarness(makeProject(), undefined, {
      hostId: 'host-b',
      runCoordinator,
      runStore,
    });
    const firstClient = await owner.connect();
    const firstMessages = collectMessages(firstClient);

    firstClient.send(JSON.stringify(makeStartMessage('request-cross-host-cancel')));
    const accepted = await firstMessages.next('action.accepted');
    firstClient.close();
    await waitForClose(firstClient);

    const resumedClient = await reconnect.connect();
    const resumedMessages = collectMessages(resumedClient);
    resumedClient.send(JSON.stringify({ type: 'run.resume', runId: accepted.runId, lastSequence: 1 }));
    await resumedMessages.next('action.progress');
    resumedClient.send(JSON.stringify({ type: 'action.cancel', runId: accepted.runId }));
    const cancelled = await resumedMessages.next('action.cancelled');

    assert.equal(cancelled.runId, accepted.runId);
    assert.equal(owner.gateway.getActiveRunCount(), 0);

    await owner.gateway.dispose();
    await reconnect.gateway.dispose();
  });

  void it('settles a reconnected client after a replacement worker recovers an expired owner lease', async () => {
    const runStore = createInMemoryRivetWebAppRunStore();
    const runCoordinator = createInMemoryRivetWebAppRunCoordinator();
    const created = await runStore.createRun({
      componentId: 'run-button',
      createdAt: Date.now(),
      hostId: 'deleted-deployment-pod',
      leaseDurationMs: 40,
      leaseId: 'deleted-pod-lease',
      ownerScope: 'user:project:app:revision',
      requestId: 'request-deleted-pod',
      runId: 'run-deleted-pod',
    });
    const leaseExpiresAt = created.run.leaseExpiresAt;
    await runStore.appendEvent('run-deleted-pod', 'deleted-pod-lease', {
      type: 'action.accepted',
      requestId: 'request-deleted-pod',
      runId: 'run-deleted-pod',
    });
    const firstReplacement = await createHarness(makeProject(), undefined, {
      hostId: 'replacement-pod-a',
      runCoordinator,
      runStore,
    });
    const secondReplacement = await createHarness(makeProject(), undefined, {
      hostId: 'replacement-pod-b',
      runCoordinator,
      runStore,
    });
    const client = await firstReplacement.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify({ type: 'run.resume', runId: 'run-deleted-pod', lastSequence: 0 }));
    await messages.next('action.accepted');
    await delay(Math.max(0, leaseExpiresAt - Date.now()) + 5);
    const recovered = await Promise.all([
      firstReplacement.gateway.recoverInterruptedRuns(),
      secondReplacement.gateway.recoverInterruptedRuns(),
    ]);
    const interrupted = await messages.next('action.interrupted');

    assert.equal(
      recovered.reduce((total, count) => total + count, 0),
      1,
    );
    assert.equal(interrupted.runId, 'run-deleted-pod');
    assert.match(interrupted.error, /owner lease expired/);
    assert.equal((await runStore.getRun('run-deleted-pod'))?.status, 'interrupted');

    await firstReplacement.gateway.dispose();
    await secondReplacement.gateway.dispose();
  });

  void it('rejects an impossible resume sequence instead of leaving the client pending', async () => {
    const harness = await createHarness(makeProject());
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-invalid-resume-sequence')));
    const accepted = await messages.next('action.accepted');
    await messages.next('action.progress');
    await messages.next('action.completed');
    client.send(JSON.stringify({ type: 'run.resume', runId: accepted.runId, lastSequence: 999 }));
    const rejected = await messages.next('run.rejected');

    assert.equal(rejected.runId, accepted.runId);
    assert.equal(rejected.code, 'run_unavailable');
  });

  void it('rejects a running row owned by another host instead of attaching forever', async () => {
    const store = createInMemoryRivetWebAppRunStore();
    await store.createRun({
      componentId: 'run-button',
      createdAt: 1,
      hostId: 'host-a',
      ...activeLease(),
      ownerScope: 'user:project:app:revision',
      requestId: 'request-on-another-host',
      runId: 'run-on-another-host',
    });
    await store.appendEvent('run-on-another-host', TEST_LEASE_ID, {
      type: 'action.accepted',
      requestId: 'request-on-another-host',
      runId: 'run-on-another-host',
    });
    const harness = await createHarness(makeProject(), undefined, { hostId: 'host-b', runStore: store });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-on-another-host')));
    await messages.next('action.accepted');
    const rejected = await messages.next('run.rejected');

    assert.equal(rejected.runId, 'run-on-another-host');
    assert.equal(rejected.code, 'run_unavailable');
  });

  void it('rejects a run that disappears during attachment instead of waiting forever', async () => {
    const storedRun = {
      componentId: 'run-button',
      createdAt: 1,
      events: [
        {
          type: 'action.accepted' as const,
          requestId: 'request-pruned-during-attach',
          runId: 'run-pruned-during-attach',
          sequence: 1,
        },
      ],
      hostId: 'host-a',
      lastSequence: 1,
      leaseExpiresAt: Date.now() + 60_000,
      leaseId: TEST_LEASE_ID,
      ownerScope: 'user:project:app:revision',
      requestId: 'request-pruned-during-attach',
      runId: 'run-pruned-during-attach',
      status: 'running' as const,
      updatedAt: 1,
    };
    const disappearingStore = {
      async appendEvent() {
        return undefined;
      },
      async createRun() {
        return { created: false, run: storedRun };
      },
      async getRun() {
        return undefined;
      },
      async getRunByRequestId() {
        return storedRun;
      },
      async interruptExpiredRuns() {
        return [];
      },
      async interruptRunsByLease() {
        return [];
      },
      async renewRunLeases() {
        return [];
      },
    };
    const harness = await createHarness(makeProject(), undefined, {
      hostId: 'host-b',
      runStore: disappearingStore,
    });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-pruned-during-attach')));
    await messages.next('action.accepted');
    const rejected = await messages.next('run.rejected');

    assert.equal(rejected.runId, 'run-pruned-during-attach');
    assert.equal(rejected.code, 'run_unavailable');
  });

  void it('cancels an accepted run without waiting for the graph to finish', async () => {
    const project = makeProject(2_000);
    const harness = await createHarness(project);
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-cancel')));
    const accepted = await messages.next('action.accepted');
    client.send(JSON.stringify({ type: 'action.cancel', runId: accepted.runId }));
    const cancelled = await messages.next('action.cancelled');

    assert.equal(cancelled.runId, accepted.runId);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('does not let another owner scope resume or cancel a run', async () => {
    const project = makeProject(120);
    const harness = await createHarness(project);
    const ownerClient = await harness.connect('owner-a');
    const ownerMessages = collectMessages(ownerClient);
    const otherClient = await harness.connect('owner-b');
    const otherMessages = collectMessages(otherClient);

    ownerClient.send(JSON.stringify(makeStartMessage('request-owned')));
    const accepted = await ownerMessages.next('action.accepted');
    otherClient.send(JSON.stringify({ type: 'action.cancel', runId: accepted.runId }));
    otherClient.send(JSON.stringify({ type: 'run.resume', runId: accepted.runId, lastSequence: 0 }));

    const rejections = await Promise.all([otherMessages.next('run.rejected'), otherMessages.next('run.rejected')]);
    const completed = await ownerMessages.next('action.completed');
    assert.ok(rejections.every((rejection) => rejection.code === 'run_unavailable'));
    assert.equal(completed.runId, accepted.runId);
  });

  void it('rejects resume and cancel for unavailable runs instead of leaving clients pending', async () => {
    const harness = await createHarness(makeProject());
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify({ type: 'run.resume', runId: 'missing-run', lastSequence: 0 }));
    const resumeRejected = await messages.next('run.rejected');
    client.send(JSON.stringify({ type: 'action.cancel', runId: 'missing-run' }));
    const cancelRejected = await messages.next('run.rejected');

    assert.equal(resumeRejected.code, 'run_unavailable');
    assert.equal(cancelRejected.code, 'run_unavailable');
  });

  void it('replays a terminal result when cancellation races with completion', async () => {
    const harness = await createHarness(makeProject());
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-terminal-cancel')));
    const accepted = await messages.next('action.accepted');
    await messages.next('action.progress');
    await messages.next('action.completed');
    client.send(JSON.stringify({ type: 'action.cancel', runId: accepted.runId }));
    const replayed = await messages.next('action.completed');

    assert.equal(replayed.runId, accepted.runId);
    assert.deepEqual(replayed.statePatch, { result: 'Hello' });
  });

  void it('reserves active-run capacity before asynchronous setup finishes', async () => {
    const project = makeProject(120);
    const harness = await createHarness(project, undefined, { maxActiveRunsPerScope: 1 });
    const firstClient = await harness.connect();
    const secondClient = await harness.connect();
    const firstMessages = collectMessages(firstClient);
    const secondMessages = collectMessages(secondClient);

    firstClient.send(JSON.stringify(makeStartMessage('request-first')));
    secondClient.send(JSON.stringify(makeStartMessage('request-second')));

    const outcomes = await Promise.all([
      firstMessages.nextOf(['action.accepted', 'action.rejected']),
      secondMessages.nextOf(['action.accepted', 'action.rejected']),
    ]);
    assert.deepEqual(outcomes.map(({ type }) => type).sort(), ['action.accepted', 'action.rejected']);
    const rejected = outcomes.find(
      (message): message is Extract<RivetWebAppServerMessage, { type: 'action.rejected' }> =>
        message.type === 'action.rejected',
    )!;
    assert.equal(rejected.error, 'Too many active web app actions.');
  });

  void it('releases reserved capacity when run-store creation fails', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const observedErrors: string[] = [];
    let createAttempts = 0;
    const flakyStore = {
      ...baseStore,
      async createRun(...args: Parameters<typeof baseStore.createRun>) {
        createAttempts += 1;
        if (createAttempts === 1) throw new Error('Temporary create failure.');
        return baseStore.createRun(...args);
      },
    };
    const harness = await createHarness(makeProject(), undefined, {
      maxActiveRunsPerScope: 1,
      onError: (error) => observedErrors.push(error instanceof Error ? error.message : String(error)),
      runStore: flakyStore,
    });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-create-fails')));
    const rejected = await messages.next('action.rejected');
    assert.equal(rejected.error, 'The web app action could not be started.');
    assert.equal(rejected.code, 'action_unavailable');
    assert.deepEqual(observedErrors, ['Temporary create failure.']);

    client.send(JSON.stringify(makeStartMessage('request-after-create-failure')));
    await messages.next('action.accepted');
    await messages.next('action.progress');
    await messages.next('action.completed');
  });

  void it('persists progress before completion even when the progress write is slower', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const delayedStore = {
      ...baseStore,
      async appendEvent(...args: Parameters<typeof baseStore.appendEvent>) {
        if (args[2].type === 'action.progress') await delay(30);
        return baseStore.appendEvent(...args);
      },
    };
    const harness = await createHarness(makeProject(), undefined, { runStore: delayedStore });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-ordered-events')));
    await messages.next('action.accepted');
    const progress = await messages.next('action.progress');
    const completed = await messages.next('action.completed');

    assert.ok(progress.sequence < completed.sequence);
  });

  void it('settles attached clients when terminal persistence fails', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const observedErrors: string[] = [];
    const failingStore = {
      ...baseStore,
      async appendEvent(...args: Parameters<typeof baseStore.appendEvent>) {
        if (args[2].type === 'action.completed') throw new Error('Completion persistence failed.');
        return baseStore.appendEvent(...args);
      },
    };
    const harness = await createHarness(makeProject(), undefined, {
      onError: (error) => observedErrors.push(error instanceof Error ? error.message : String(error)),
      runStore: failingStore,
    });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-terminal-store-failure')));
    const accepted = await messages.next('action.accepted');
    await messages.next('action.progress');
    const rejected = await messages.next('run.rejected');
    await delay(0);

    assert.equal(rejected.runId, accepted.runId);
    assert.equal(rejected.code, 'run_unavailable');
    assert.deepEqual(observedErrors, ['Completion persistence failed.']);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });

  void it('stops renewing a completed processor whose terminal event was rejected by the store', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const rejectingStore = {
      ...baseStore,
      async appendEvent(...args: Parameters<typeof baseStore.appendEvent>) {
        if (args[2].type === 'action.completed') return undefined;
        return baseStore.appendEvent(...args);
      },
    };
    const failedRuns: Array<{ error?: unknown; outcome: string }> = [];
    const harness = await createHarness(
      makeProject(),
      undefined,
      {
        leaseDurationMs: 40,
        leaseRenewIntervalMs: 10,
        runStore: rejectingStore,
      },
      {
        onRunFailed({ error, outcome }) {
          failedRuns.push({ error, outcome });
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-rejected-terminal')));
    const accepted = await messages.next('action.accepted');
    await messages.next('action.progress');
    const interrupted = await messages.next('action.interrupted', 1_000);

    assert.equal(interrupted.runId, accepted.runId);
    assert.equal((await baseStore.getRun(accepted.runId))?.status, 'interrupted');
    assert.equal(harness.gateway.getActiveRunCount(), 0);
    assert.deepEqual(failedRuns, [
      {
        error: 'Web app action owner lease expired before completion.',
        outcome: 'interrupted',
      },
    ]);
  });

  void it('bounds retained progress history while preserving accepted and terminal events', async () => {
    const store = createInMemoryRivetWebAppRunStore({ maxEventsPerRun: 3, maxStoredRuns: 5 });
    await store.createRun({
      componentId: 'button',
      createdAt: 1,
      hostId: 'host',
      ...activeLease(),
      ownerScope: 'owner',
      requestId: 'request',
      runId: 'run',
    });
    await store.appendEvent('run', TEST_LEASE_ID, { type: 'action.accepted', requestId: 'request', runId: 'run' });
    for (let percent = 10; percent <= 50; percent += 10) {
      await store.appendEvent('run', TEST_LEASE_ID, {
        type: 'action.progress',
        progress: { percent },
        requestId: 'request',
        runId: 'run',
      });
    }
    await store.appendEvent('run', TEST_LEASE_ID, {
      type: 'action.completed',
      requestId: 'request',
      runId: 'run',
      statePatch: {},
    });

    const run = await store.getRun('run');
    assert.equal(run?.lastSequence, 7);
    assert.deepEqual(
      run?.events.map((event) => [event.type, event.sequence]),
      [
        ['action.accepted', 1],
        ['action.progress', 6],
        ['action.completed', 7],
      ],
    );
  });

  void it('enforces the in-memory run capacity while all retained runs are active', async () => {
    const store = createInMemoryRivetWebAppRunStore({ maxStoredRuns: 1 });
    await store.createRun({
      componentId: 'button',
      createdAt: 1,
      hostId: 'host',
      ...activeLease(),
      ownerScope: 'owner',
      requestId: 'request-1',
      runId: 'run-1',
    });

    await assert.rejects(
      () =>
        store.createRun({
          componentId: 'button',
          createdAt: 2,
          hostId: 'host',
          ...activeLease('second-lease'),
          ownerScope: 'owner',
          requestId: 'request-2',
          runId: 'run-2',
        }),
      /run store capacity reached/,
    );

    await store.appendEvent('run-1', TEST_LEASE_ID, {
      type: 'action.completed',
      requestId: 'request-1',
      runId: 'run-1',
      statePatch: {},
    });
    const replacement = await store.createRun({
      componentId: 'button',
      createdAt: 3,
      hostId: 'host',
      ...activeLease('second-lease'),
      ownerScope: 'owner',
      requestId: 'request-2',
      runId: 'run-2',
    });
    assert.equal(replacement.created, true);
  });

  void it('interrupts only runs owned by the selected lease', async () => {
    const store = createInMemoryRivetWebAppRunStore();
    for (const hostId of ['host-a', 'host-b']) {
      await store.createRun({
        componentId: 'button',
        createdAt: 1,
        hostId,
        ...activeLease(`lease-${hostId}`),
        ownerScope: 'owner',
        requestId: `request-${hostId}`,
        runId: `run-${hostId}`,
      });
    }

    const interrupted = await store.interruptRunsByLease('lease-host-a', 'Host A stopped.');

    assert.deepEqual(
      interrupted.map(({ runId }) => runId),
      ['run-host-a'],
    );
    assert.equal((await store.getRun('run-host-a'))?.status, 'interrupted');
    assert.equal((await store.getRun('run-host-b'))?.status, 'running');
  });

  void it('renews only live matching leases and atomically recovers expired Deployment owners', async () => {
    const store = createInMemoryRivetWebAppRunStore();
    const live = await store.createRun({
      componentId: 'button',
      createdAt: 1,
      hostId: 'deleted-deployment-pod',
      leaseDurationMs: 60_000,
      leaseId: 'old-pod-lease',
      ownerScope: 'owner',
      requestId: 'request-live',
      runId: 'run-live',
    });
    const orphan = await store.createRun({
      componentId: 'button',
      createdAt: 1,
      hostId: 'deleted-deployment-pod',
      leaseDurationMs: 60_000,
      leaseId: 'old-pod-lease',
      ownerScope: 'owner',
      requestId: 'request-orphan',
      runId: 'run-orphan',
    });
    await store.createRun({
      componentId: 'button',
      createdAt: 1,
      hostId: 'deleted-deployment-pod',
      leaseDurationMs: 1,
      leaseId: 'expired-pod-lease',
      ownerScope: 'owner',
      requestId: 'request-expired',
      runId: 'run-expired',
    });

    await delay(2);
    assert.deepEqual(await store.renewRunLeases('old-pod-lease', ['run-live'], 120_000), ['run-live']);
    assert.deepEqual(await store.renewRunLeases('expired-pod-lease', ['run-expired'], 120_000), []);
    assert.ok((await store.getRun('run-live'))!.leaseExpiresAt > live.run.leaseExpiresAt);
    assert.equal((await store.getRun('run-orphan'))?.leaseExpiresAt, orphan.run.leaseExpiresAt);
    assert.equal(
      await store.appendEvent('run-live', 'wrong-lease', {
        type: 'action.completed',
        requestId: 'request-live',
        runId: 'run-live',
        statePatch: {},
      }),
      undefined,
    );

    const replacementGateway = createRivetWebAppWebSocketGateway({ hostId: 'replacement-pod', runStore: store });
    assert.equal(await replacementGateway.recoverInterruptedRuns(), 1);
    assert.equal((await store.getRun('run-expired'))?.status, 'interrupted');
    assert.equal((await store.getRun('run-live'))?.status, 'running');
    assert.equal(
      await store.appendEvent('run-expired', 'expired-pod-lease', {
        type: 'action.completed',
        requestId: 'request-expired',
        runId: 'run-expired',
        statePatch: {},
      }),
      undefined,
    );
    await replacementGateway.dispose();
  });

  void it('keeps owner and request IDs distinct even when either contains a null character', async () => {
    const store = createInMemoryRivetWebAppRunStore();
    await store.createRun({
      componentId: 'button-a',
      createdAt: 1,
      hostId: 'host',
      ...activeLease('lease-a'),
      ownerScope: 'owner',
      requestId: '\0request',
      runId: 'run-a',
    });
    await store.createRun({
      componentId: 'button-b',
      createdAt: 2,
      hostId: 'host',
      ...activeLease('lease-b'),
      ownerScope: 'owner\0',
      requestId: 'request',
      runId: 'run-b',
    });

    assert.equal((await store.getRunByRequestId('owner', '\0request'))?.runId, 'run-a');
    assert.equal((await store.getRunByRequestId('owner\0', 'request'))?.runId, 'run-b');
  });

  void it('protects stored run identity and snapshots from caller mutation', async () => {
    const store = createInMemoryRivetWebAppRunStore();
    await store.createRun({
      componentId: 'button',
      createdAt: 1,
      hostId: 'host',
      ...activeLease(),
      ownerScope: 'owner',
      requestId: 'request',
      runId: 'run',
    });

    await assert.rejects(
      () =>
        store.appendEvent('run', TEST_LEASE_ID, {
          type: 'action.completed',
          requestId: 'another-request',
          runId: 'run',
          statePatch: {},
        }),
      /event identity/,
    );
    await assert.rejects(
      () =>
        store.createRun({
          componentId: 'button',
          createdAt: 2,
          hostId: 'host',
          ...activeLease('another-lease'),
          ownerScope: 'owner',
          requestId: 'another-request',
          runId: 'run',
        }),
      /run ID.*already in use/,
    );

    await store.appendEvent('run', TEST_LEASE_ID, {
      type: 'action.completed',
      requestId: 'request',
      runId: 'run',
      statePatch: { nested: { value: 'original' } },
    });
    const snapshot = await store.getRun('run');
    assert.ok(snapshot);
    const completed = snapshot.events.at(-1);
    assert.equal(completed?.type, 'action.completed');
    if (completed?.type === 'action.completed') {
      (completed.statePatch.nested as { value: string }).value = 'mutated';
    }
    const stored = await store.getRun('run');
    assert.deepEqual(stored?.events.at(-1), {
      type: 'action.completed',
      requestId: 'request',
      runId: 'run',
      sequence: 1,
      statePatch: { nested: { value: 'original' } },
    });
  });

  void it('interrupts active runs and closes owned sockets when disposed', async () => {
    let processorPrepared!: () => void;
    const prepared = new Promise<void>((resolve) => {
      processorPrepared = resolve;
    });
    const failedRuns: Array<{ outcome: string; requestId: string; runId: string }> = [];
    const harness = await createHarness(
      makeProject(2_000),
      undefined,
      {},
      {
        onProcessorPrepared() {
          processorPrepared();
        },
        onRunFailed({ outcome, requestId, runId }) {
          failedRuns.push({ outcome, requestId, runId });
        },
      },
    );
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-dispose')));
    const accepted = await messages.next('action.accepted');
    await prepared;
    const closePromise = waitForClose(client);
    await harness.gateway.dispose({ interrupt: true });
    const interrupted = await messages.next('action.interrupted');
    const close = await closePromise;

    assert.match(interrupted.error, /server stopped/);
    assert.equal(close.code, 1012);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
    assert.deepEqual(failedRuns, [
      {
        outcome: 'interrupted',
        requestId: 'request-dispose',
        runId: accepted.runId,
      },
    ]);
  });

  void it('closes owned sockets even when durable interruption persistence fails', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const failingStore = {
      ...baseStore,
      async interruptRunsByLease() {
        throw new Error('Interruption persistence failed.');
      },
    };
    const harness = await createHarness(makeProject(), undefined, { runStore: failingStore });
    const client = await harness.connect();
    const closePromise = waitForClose(client);

    await assert.rejects(() => harness.gateway.dispose({ interrupt: true }), /Interruption persistence failed/);
    assert.equal((await closePromise).code, 1012);
  });

  void it('rejects connections made after disposal without starting heartbeat ownership', async () => {
    const harness = await createHarness(makeProject());
    await harness.gateway.dispose();

    const client = trackWebAppTestSocket(new WebSocket(harness.url));
    const close = await waitForClose(client);

    assert.equal(close.code, 1012);
    await harness.gateway.dispose();
  });

  void it('closes a failed run-store connection even when the observability hook throws', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const failingStore = {
      ...baseStore,
      async getRun() {
        throw new Error('Run lookup failed.');
      },
    };
    const harness = await createHarness(makeProject(), undefined, {
      onError: () => {
        throw new Error('Telemetry failed.');
      },
      runStore: failingStore,
    });
    const client = await harness.connect();
    const closePromise = waitForClose(client);

    client.send(JSON.stringify({ type: 'run.resume', runId: 'run', lastSequence: 0 }));

    assert.equal((await closePromise).code, 1011);
  });

  void it('releases and aborts a run even when cancellation persistence fails', async () => {
    const baseStore = createInMemoryRivetWebAppRunStore();
    const failingStore = {
      ...baseStore,
      async appendEvent(...args: Parameters<typeof baseStore.appendEvent>) {
        if (args[2].type === 'action.cancelled') throw new Error('Cancellation persistence failed.');
        return baseStore.appendEvent(...args);
      },
    };
    const harness = await createHarness(makeProject(2_000), undefined, { runStore: failingStore });
    const client = await harness.connect();
    const messages = collectMessages(client);

    client.send(JSON.stringify(makeStartMessage('request-cancel-store-failure')));
    const accepted = await messages.next('action.accepted');
    const closePromise = waitForClose(client);
    client.send(JSON.stringify({ type: 'action.cancel', runId: accepted.runId }));

    assert.equal((await closePromise).code, 1011);
    assert.equal(harness.gateway.getActiveRunCount(), 0);
  });
});

const makeProject = (delay = 0): Project => makeWebAppProject({ delay, includeProgress: true });

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
