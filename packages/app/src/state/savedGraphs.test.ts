import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'jotai/vanilla';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { projectContextState, releaseProjectContextState } from './savedGraphs';
import {
  configureHybridStorageBackend,
  flushHybridStorageGroup,
  getWorkspaceRecoveryStorage,
  memoryStorage,
} from './storage.js';

describe('project context storage', () => {
  test('projectContextState writes values into grouped app project storage', async () => {
    const projectId = 'project-context-persist-test' as ProjectId;
    const storageKey = `projectContext__"${projectId}"`;
    const contextValue = {
      apiKey: {
        value: {
          type: 'string',
          value: 'stored locally',
        },
      },
    } as const;
    const writes: Array<{ key: string; value: string }> = [];
    const persisted = new Map<string, string>();
    const previousProjectStorage = memoryStorage.get('project');
    const previousBackend = configureHybridStorageBackend({
      getItem: async (key) => persisted.get(key) ?? null,
      setItem: async (key, value) => {
        writes.push({ key, value });
        persisted.set(key, value);
      },
      removeItem: async () => {},
    });

    try {
      memoryStorage.set('project', {});

      const store = createStore();
      store.set(projectContextState(projectId), contextValue);

      assert.deepEqual(memoryStorage.get('project'), {
        [storageKey]: contextValue,
      });

      await flushHybridStorageGroup('project');

      assert.equal(writes.at(-1)?.key, getWorkspaceRecoveryStorage().key);
      assert.deepEqual(JSON.parse(writes.at(-1)!.value).groups.project, {
        [storageKey]: contextValue,
      });
    } finally {
      projectContextState.remove(projectId);
      configureHybridStorageBackend(previousBackend);
      if (previousProjectStorage === undefined) {
        memoryStorage.delete('project');
      } else {
        memoryStorage.set('project', previousProjectStorage);
      }
    }
  });

  test('releaseProjectContextState keeps persisted per-project context values', () => {
    const projectId = 'project-context-release-test' as ProjectId;
    const storageKey = `projectContext__"${projectId}"`;
    const previousProjectStorage = memoryStorage.get('project');

    try {
      memoryStorage.set('project', {
        [storageKey]: {
          apiKey: {
            value: {
              type: 'string',
              value: 'stored locally',
            },
          },
        },
      });

      releaseProjectContextState(projectId);

      assert.deepEqual(memoryStorage.get('project'), {
        [storageKey]: {
          apiKey: {
            value: {
              type: 'string',
              value: 'stored locally',
            },
          },
        },
      });
    } finally {
      if (previousProjectStorage === undefined) {
        memoryStorage.delete('project');
      } else {
        memoryStorage.set('project', previousProjectStorage);
      }
    }
  });
});
