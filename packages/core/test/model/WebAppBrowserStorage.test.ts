import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import 'fake-indexeddb/auto';
import {
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessagesStateKey,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '../../src/model/UiGraph.js';
import {
  getUiGraphChatStorageKey,
  getUiGraphWebAppStorageKey,
  getUiGraphResponseTraceStorageKey,
} from '../../src/model/UiGraphBrowserRuntime.js';
import type { AgentResponseTrace } from '../../src/model/AgentResponseTrace.js';
import { UiGraphBrowserPersistence } from '../../src/model/UiGraphIndexedDbPersistence.js';
import {
  IndexedDbWebAppBrowserStorage,
  RIVET_WEB_APP_BROWSER_STORAGE_CHUNK_BYTES,
  RIVET_WEB_APP_LEGACY_RETENTION_MS,
} from '../../src/model/WebAppBrowserStorage.js';

const scope = { origin: 'https://example.test', pathname: '/apps/chat/', uiGraphId: 'chat-app' };

describe('IndexedDbWebAppBrowserStorage', () => {
  it('round-trips chunked Unicode JSON, replaces generations, and deletes records', async () => {
    const databaseName = uniqueDatabaseName();
    const writer = new IndexedDbWebAppBrowserStorage({ databaseName, indexedDB });
    const reader = new IndexedDbWebAppBrowserStorage({ databaseName, indexedDB });
    await writer.initialize(scope);
    await reader.initialize(scope);
    const largeValue = { text: `start-${'🙂'.repeat(RIVET_WEB_APP_BROWSER_STORAGE_CHUNK_BYTES)}-end` };

    await writer.set('stored-values', 'values', largeValue);
    assert.deepEqual(await reader.get('stored-values', 'values'), largeValue);

    await writer.set('stored-values', 'values', { text: 'replacement' });
    const freshReader = new IndexedDbWebAppBrowserStorage({ databaseName, indexedDB });
    await freshReader.initialize(scope);
    assert.deepEqual(await freshReader.get('stored-values', 'values'), { text: 'replacement' });

    await writer.delete('stored-values', 'values');
    const deletedReader = new IndexedDbWebAppBrowserStorage({ databaseName, indexedDB });
    await deletedReader.initialize(scope);
    assert.equal(await deletedReader.get('stored-values', 'values'), undefined);

    writer.dispose();
    reader.dispose();
    freshReader.dispose();
    deletedReader.dispose();
  });

  it('serializes concurrent writes and returns monotonically increasing revisions', async () => {
    const storage = new IndexedDbWebAppBrowserStorage({
      databaseName: uniqueDatabaseName(),
      indexedDB,
      now: () => 10,
    });
    await storage.initialize(scope);

    const [first, second, third] = await Promise.all([
      storage.set('stored-values', 'values', { sequence: 1 }),
      storage.set('stored-values', 'values', { sequence: 2 }),
      storage.set('stored-values', 'values', { sequence: 3 }),
    ]);

    assert.ok(first.revision < second.revision && second.revision < third.revision);
    assert.deepEqual(await storage.get('stored-values', 'values'), { sequence: 3 });
    storage.dispose();
  });
  it('allocates newer revisions across tabs even when their clocks collide', async () => {
    const databaseName = uniqueDatabaseName();
    const noBroadcast = () => {
      throw new Error('BroadcastChannel unavailable');
    };
    const first = new IndexedDbWebAppBrowserStorage({
      broadcastChannelFactory: noBroadcast,
      databaseName,
      indexedDB,
      now: () => 10,
    });
    const second = new IndexedDbWebAppBrowserStorage({
      broadcastChannelFactory: noBroadcast,
      databaseName,
      indexedDB,
      now: () => 10,
    });
    await first.initialize(scope);
    await second.initialize(scope);

    const firstCommit = await first.set('stored-values', 'shared', { writer: 'first' });
    const secondCommit = await second.set('stored-values', 'shared', { writer: 'second' });

    assert.ok(secondCommit.revision > firstCommit.revision);
    const reader = new IndexedDbWebAppBrowserStorage({ databaseName, indexedDB });
    await reader.initialize(scope);
    assert.deepEqual(await reader.get('stored-values', 'shared'), { writer: 'second' });

    first.dispose();
    second.dispose();
    reader.dispose();
  });

  it('commits a multi-record batch and rejects non-portable JSON before writing', async () => {
    const storage = new IndexedDbWebAppBrowserStorage({ databaseName: uniqueDatabaseName(), indexedDB });
    await storage.initialize(scope);
    await storage.commitBatch([
      { key: 'state', namespace: 'chat-state', value: { draft: 'hello' } },
      { key: 'values', namespace: 'stored-values', value: { count: 2 } },
    ]);
    assert.deepEqual(await storage.get('chat-state', 'state'), { draft: 'hello' });
    assert.deepEqual(await storage.get('stored-values', 'values'), { count: 2 });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(storage.set('stored-values', 'invalid', cyclic as never), /portable|cycles/i);
    assert.equal(await storage.get('stored-values', 'invalid'), undefined);
    storage.dispose();
  });

  it('invalidates another tab after its own queued write completes', async () => {
    FakeBroadcastChannel.reset();
    const databaseName = uniqueDatabaseName();
    const channelFactory = (name: string) => new FakeBroadcastChannel(name) as unknown as BroadcastChannel;
    const first = new IndexedDbWebAppBrowserStorage({
      broadcastChannelFactory: channelFactory,
      databaseName,
      indexedDB,
    });
    const second = new IndexedDbWebAppBrowserStorage({
      broadcastChannelFactory: channelFactory,
      databaseName,
      indexedDB,
    });
    await first.initialize(scope);
    await second.initialize(scope);
    const changes: string[] = [];
    second.subscribe((change) => changes.push(`${change.namespace}:${change.key}`));

    await first.set('stored-values', 'values', { version: 1 });
    await waitFor(() => changes.length === 1);
    assert.deepEqual(await second.get('stored-values', 'values'), { version: 1 });

    first.dispose();
    second.dispose();
    FakeBroadcastChannel.reset();
  });

  it('lists independent Stored Value records and keeps tombstones out of snapshots', async () => {
    const storage = new IndexedDbWebAppBrowserStorage({ databaseName: uniqueDatabaseName(), indexedDB });
    await storage.initialize(scope);
    await storage.commitBatch([
      { key: 'alpha', namespace: 'stored-values', value: { size: 1 } },
      { key: 'beta', namespace: 'stored-values', value: ['b'] },
    ]);
    assert.deepEqual(await storage.list('stored-values'), [
      { key: 'alpha', value: { size: 1 } },
      { key: 'beta', value: ['b'] },
    ]);
    await storage.delete('stored-values', 'alpha');
    assert.deepEqual(await storage.list('stored-values'), [{ key: 'beta', value: ['b'] }]);
    assert.equal(await storage.get('stored-values', 'alpha'), undefined);
    storage.dispose();
  });

  it('keeps failed durable writes readable from the current page memory mirror', async () => {
    const storage = new IndexedDbWebAppBrowserStorage({ indexedDB: null });
    assert.deepEqual(await storage.initialize(scope), {
      durable: false,
      reason: 'indexeddb-unavailable',
    });

    await assert.rejects(storage.set('stored-values', 'memory-only', { retained: true }), /could not be saved/i);
    assert.deepEqual(await storage.get('stored-values', 'memory-only'), { retained: true });
    assert.equal(storage.hasMemoryOnlyRecord('stored-values', 'memory-only'), true);
    assert.deepEqual(await storage.list('stored-values'), [{ key: 'memory-only', value: { retained: true } }]);
    storage.dispose();
  });
  it('keeps a failed local write visible when another tab publishes the same key', async () => {
    FakeBroadcastChannel.reset();
    const databaseName = uniqueDatabaseName();
    const channelFactory = (name: string) => new FakeBroadcastChannel(name) as unknown as BroadcastChannel;
    const local = new IndexedDbWebAppBrowserStorage({
      broadcastChannelFactory: channelFactory,
      databaseName,
      indexedDB: null,
    });
    const remote = new IndexedDbWebAppBrowserStorage({
      broadcastChannelFactory: channelFactory,
      databaseName,
      indexedDB,
    });
    await local.initialize(scope);
    await remote.initialize(scope);

    await assert.rejects(local.set('stored-values', 'shared', { source: 'local-memory' }), /could not be saved/i);
    await remote.set('stored-values', 'shared', { source: 'remote-durable' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(await local.get('stored-values', 'shared'), { source: 'local-memory' });
    assert.deepEqual(await remote.get('stored-values', 'shared'), { source: 'remote-durable' });
    local.dispose();
    remote.dispose();
    FakeBroadcastChannel.reset();
  });
});

describe('UiGraphBrowserPersistence legacy migration', () => {
  it('imports exact Rivet-owned keys once and retains the frozen rollback copy for 30 days', async () => {
    const databaseName = uniqueDatabaseName();
    const uiGraph = makeChatGraph();
    const location = { origin: scope.origin, pathname: scope.pathname };
    const legacy = createMemoryStorage();
    const chatKey = getUiGraphChatStorageKey(uiGraph, location)!;
    const valuesKey = getUiGraphWebAppStorageKey(uiGraph, location)!;
    const draftKey = getUiGraphChatDraftStateKey('chat');
    const messagesKey = getUiGraphChatMessagesStateKey('chat');
    legacy.setItem(chatKey, JSON.stringify({ [draftKey]: 'draft', [messagesKey]: [{ role: 'user', content: 'Hi' }] }));
    legacy.setItem(valuesKey, JSON.stringify({ profile: { name: 'Ada' } }));
    legacy.setItem('host-site-data', 'keep me');

    const first = new UiGraphBrowserPersistence(uiGraph, {
      databaseName,
      indexedDB,
      legacyStorage: legacy,
      location,
      now: () => 1_000,
    });
    assert.deepEqual(await first.initialize(), { durable: true });
    assert.equal((await first.loadChatState())[draftKey], 'draft');
    assert.deepEqual(await first.loadStoredValues(), { profile: { name: 'Ada' } });
    assert.ok(legacy.getItem(chatKey));
    assert.ok(legacy.getItem(valuesKey));
    first.dispose();

    legacy.setItem(chatKey, JSON.stringify({ [draftKey]: 'older rollback value' }));
    const afterDeadline = new UiGraphBrowserPersistence(uiGraph, {
      databaseName,
      indexedDB,
      legacyStorage: legacy,
      location,
      now: () => 1_001 + RIVET_WEB_APP_LEGACY_RETENTION_MS,
    });
    await afterDeadline.initialize();
    assert.equal((await afterDeadline.loadChatState())[draftKey], 'draft');
    assert.equal(legacy.getItem(chatKey), null);
    assert.equal(legacy.getItem(valuesKey), null);
    assert.equal(legacy.getItem('host-site-data'), 'keep me');
    afterDeadline.dispose();
  });

  it('recovers an unrecorded legacy Chat and Stored Value once, then keeps IndexedDB authoritative', async () => {
    const databaseName = uniqueDatabaseName();
    const uiGraph = makeChatGraph();
    const location = { origin: scope.origin, pathname: '/apps/recover-pending-legacy' };
    const legacy = createMemoryStorage();
    const chatKey = getUiGraphChatStorageKey(uiGraph, location)!;
    const valuesKey = getUiGraphWebAppStorageKey(uiGraph, location)!;
    const draftKey = getUiGraphChatDraftStateKey('chat');
    const persistence = new UiGraphBrowserPersistence(uiGraph, {
      databaseName,
      indexedDB,
      legacyStorage: legacy,
      location,
    });
    await persistence.initialize();

    legacy.setItem(chatKey, JSON.stringify({ [draftKey]: 'legacy draft' }));
    legacy.setItem(valuesKey, JSON.stringify({ profile: { name: 'Ada' } }));
    assert.equal((await persistence.loadChatState())[draftKey], 'legacy draft');
    assert.deepEqual(await persistence.loadStoredValue('profile'), { name: 'Ada' });

    legacy.setItem(chatKey, JSON.stringify({ [draftKey]: 'stale legacy draft' }));
    legacy.setItem(valuesKey, JSON.stringify({ profile: { name: 'Legacy value' } }));
    await persistence.applyStoredValuePatch({ profile: { name: 'Grace' } });

    assert.equal((await persistence.loadChatState())[draftKey], 'legacy draft');
    assert.deepEqual(await persistence.loadStoredValue('profile'), { name: 'Grace' });
    assert.deepEqual(JSON.parse(legacy.getItem(valuesKey)!), { profile: { name: 'Legacy value' } });
    persistence.dispose();
  });
  it('clears a migration warning after a later import succeeds', async () => {
    const uiGraph = makeChatGraph();
    const location = { origin: scope.origin, pathname: '/apps/recovered-migration' };
    const legacy = createMemoryStorage();
    const valuesKey = getUiGraphWebAppStorageKey(uiGraph, location)!;
    legacy.setItem(valuesKey, '{not-json');
    const persistence = new UiGraphBrowserPersistence(uiGraph, {
      databaseName: uniqueDatabaseName(),
      indexedDB,
      legacyStorage: legacy,
      location,
    });

    await persistence.initialize();
    assert.equal(persistence.warning?.code, 'migration-failed');

    legacy.setItem(valuesKey, JSON.stringify({ restored: true }));
    await persistence.applyStoredValuePatch({ newer: true });

    assert.equal(persistence.warning, undefined);
    assert.deepEqual(await persistence.loadStoredValues(), { newer: true, restored: true });
    persistence.dispose();
  });
  it('serializes concurrent response-trace saves without dropping an earlier trace', async () => {
    const uiGraph = makeChatGraph();
    const persistence = new UiGraphBrowserPersistence(uiGraph, {
      databaseName: uniqueDatabaseName(),
      indexedDB,
      legacyStorage: createMemoryStorage(),
      location: { origin: scope.origin, pathname: '/apps/concurrent-traces' },
    });
    await persistence.initialize();

    await Promise.all([
      persistence.saveResponseTrace('chat', makeResponseTrace('trace-first')),
      persistence.saveResponseTrace('chat', makeResponseTrace('trace-second')),
    ]);

    assert.equal((await persistence.loadResponseTrace('chat', 'trace-first'))?.traceId, 'trace-first');
    assert.equal((await persistence.loadResponseTrace('chat', 'trace-second'))?.traceId, 'trace-second');
    persistence.dispose();
  });
  it('leaves corrupt legacy data untouched and reports a migration warning', async () => {
    const uiGraph = makeChatGraph();
    const location = { origin: scope.origin, pathname: '/apps/corrupt' };
    const legacy = createMemoryStorage();
    const chatKey = getUiGraphChatStorageKey(uiGraph, location)!;
    const valuesKey = getUiGraphWebAppStorageKey(uiGraph, location)!;
    const draftKey = getUiGraphChatDraftStateKey('chat');
    legacy.setItem(chatKey, JSON.stringify({ [draftKey]: 'valid draft' }));
    legacy.setItem(valuesKey, '{not-json');
    const persistence = new UiGraphBrowserPersistence(uiGraph, {
      databaseName: uniqueDatabaseName(),
      indexedDB,
      legacyStorage: legacy,
      location,
    });

    await persistence.initialize();
    assert.equal(persistence.warning?.code, 'migration-failed');
    assert.equal((await persistence.loadChatState())[draftKey], 'valid draft');
    assert.equal(legacy.getItem(valuesKey), '{not-json');
    persistence.dispose();
  });

  it('keeps the legacy path available when IndexedDB cannot be opened', async () => {
    const uiGraph = makeChatGraph();
    const location = { origin: scope.origin, pathname: '/apps/no-indexeddb' };
    const legacy = createMemoryStorage();
    const persistence = new UiGraphBrowserPersistence(uiGraph, {
      indexedDB: null,
      legacyStorage: legacy,
      location,
    });
    await persistence.initialize();
    await persistence.applyStoredValuePatch({ theme: 'dark' });

    assert.equal(persistence.status.durable, false);
    assert.deepEqual(JSON.parse(legacy.getItem(getUiGraphWebAppStorageKey(uiGraph, location)!)!), { theme: 'dark' });
    persistence.dispose();
  });

  it('does not mark schema-invalid Chat or trace payloads as migrated', async () => {
    const uiGraph = makeChatGraph();
    const location = { origin: scope.origin, pathname: '/apps/invalid-owned-data' };
    const legacy = createMemoryStorage();
    const chatKey = getUiGraphChatStorageKey(uiGraph, location)!;
    const traceKey = getUiGraphResponseTraceStorageKey(uiGraph, 'chat', location)!;
    legacy.setItem(chatKey, JSON.stringify({ [getUiGraphChatMessagesStateKey('chat')]: [{ role: 'user' }] }));
    legacy.setItem(traceKey, JSON.stringify([{ schemaVersion: 1, traceId: 'incomplete' }]));
    const databaseName = uniqueDatabaseName();
    const first = new UiGraphBrowserPersistence(uiGraph, {
      databaseName,
      indexedDB,
      legacyStorage: legacy,
      location,
    });
    await first.initialize();
    assert.equal(first.warning?.code, 'migration-failed');
    assert.ok(legacy.getItem(chatKey));
    assert.ok(legacy.getItem(traceKey));
    first.dispose();

    legacy.setItem(chatKey, JSON.stringify({}));
    const second = new UiGraphBrowserPersistence(uiGraph, {
      databaseName,
      indexedDB,
      legacyStorage: legacy,
      location,
    });
    await second.initialize();
    assert.equal(second.warning?.code, 'migration-failed');
    assert.ok(legacy.getItem(traceKey));
    second.dispose();
  });
});

function makeResponseTrace(traceId: string): AgentResponseTrace {
  return {
    schemaVersion: 1,
    traceId,
    scope: 'response',
    rootRunId: traceId,
    graphRunId: `graph-${traceId}`,
    graphId: 'main-graph',
    startedAt: 1,
    responseReadyAt: 2,
    status: 'completed',
    summary: {
      modelCallCount: 0,
      toolCallCount: 0,
      retryCount: 0,
      fallbackCount: 0,
      knownCostUsd: 0,
      costStatus: 'unknown',
    },
    modelCalls: [],
    toolCalls: [],
    omittedModelCallCount: 0,
    omittedToolCallCount: 0,
  } as AgentResponseTrace;
}
function makeChatGraph(): UiGraph {
  return {
    components: [
      {
        action: { type: 'runGraph' },
        allowResponseInspection: true,
        id: 'chat' as UiComponentId,
        type: 'chat',
      },
    ],
    id: 'chat-app' as UiGraphId,
    name: 'Chat app',
  };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function uniqueDatabaseName(): string {
  return `rivet-web-app-storage-test-${crypto.randomUUID()}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for cross-tab storage invalidation.');
}

class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(readonly name: string) {
    const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    FakeBroadcastChannel.channels.set(name, channels);
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  postMessage(value: unknown): void {
    for (const channel of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (channel === this) continue;
      queueMicrotask(() => channel.onmessage?.({ data: value } as MessageEvent<unknown>));
    }
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }
}
