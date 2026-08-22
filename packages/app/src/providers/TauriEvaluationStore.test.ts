import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { createEmptyEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import {
  LocalEvaluationRunStore,
  type EvaluationKeyValueBackend,
  type EvaluationStoreEntry,
} from './EvaluationRunStore.js';
import { TauriEvaluationStore } from './TauriEvaluationStore.js';

function memoryBackend(): EvaluationKeyValueBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    entries: async () => [...values].map(([key, value]) => ({ key, value })),
  };
}

function library(projectId: string) {
  return {
    version: 1 as const,
    data: createEmptyEvaluationProjectData(),
    datasets: [],
    migratedLegacyProjectIds: [projectId as ProjectId],
  };
}

test('desktop migration copies browser data before making SQLite authoritative', async () => {
  const browserBackend = memoryBackend();
  const nativeBackend = memoryBackend();
  const browserStore = new LocalEvaluationRunStore({ backend: browserBackend });
  await browserStore.putLibrary(library('legacy-project'));
  let migrationComplete = false;
  const store = new TauriEvaluationStore({
    browserStore,
    backend: nativeBackend,
    migrationApi: {
      completed: async () => migrationComplete,
      import: async (_migrationId: string, entries: readonly EvaluationStoreEntry[]) => {
        for (const entry of entries) await nativeBackend.set(entry.key, entry.value);
        migrationComplete = true;
      },
    },
  });

  assert.equal(await store.initialize(), undefined);
  assert.deepEqual((await store.getLibrary()).migratedLegacyProjectIds, ['legacy-project']);
  await store.putLibrary(library('native-project'));
  assert.deepEqual((await store.getLibrary()).migratedLegacyProjectIds, ['native-project']);
  assert.deepEqual((await browserStore.getLibrary()).migratedLegacyProjectIds, ['legacy-project']);
});

test('a failed desktop migration keeps every write on the browser store for the session', async () => {
  const browserBackend = memoryBackend();
  const nativeBackend = memoryBackend();
  const browserStore = new LocalEvaluationRunStore({ backend: browserBackend });
  await browserStore.putLibrary(library('legacy-project'));
  const store = new TauriEvaluationStore({
    browserStore,
    backend: nativeBackend,
    migrationApi: {
      completed: async () => false,
      import: async () => {
        throw new Error('simulated migration failure');
      },
    },
  });

  const initialization = await store.initialize();
  assert.match(initialization?.warning ?? '', /legacy browser store/);
  await store.putLibrary(library('fallback-project'));
  assert.deepEqual((await browserStore.getLibrary()).migratedLegacyProjectIds, ['fallback-project']);
  assert.equal(nativeBackend.values.size, 0);
});

test('an unreadable browser migration source keeps SQLite inactive for the session', async () => {
  class UnreadableBrowserStore extends LocalEvaluationRunStore {
    override async exportEntries(): Promise<readonly EvaluationStoreEntry[]> {
      throw new Error('browser source unavailable');
    }
  }

  const browserBackend = memoryBackend();
  const nativeBackend = memoryBackend();
  const browserStore = new UnreadableBrowserStore({ backend: browserBackend });
  await browserStore.putLibrary(library('legacy-project'));
  const store = new TauriEvaluationStore({
    browserStore,
    backend: nativeBackend,
    migrationApi: {
      completed: async () => false,
      import: async () => {
        throw new Error('migration import must not run');
      },
    },
  });

  const initialization = await store.initialize();
  assert.match(initialization?.warning ?? '', /browser source unavailable/);
  await store.putLibrary(library('fallback-project'));
  assert.deepEqual((await browserStore.getLibrary()).migratedLegacyProjectIds, ['fallback-project']);
  assert.equal(nativeBackend.values.size, 0);
});
