import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createRivetWebAppStorageExternalFunctions,
  RIVET_WEB_APP_STORAGE_GET_FUNCTION_NAME,
  RIVET_WEB_APP_STORAGE_SET_FUNCTION_NAME,
} from '../../src/index.js';

describe('UiGraphWebAppStorage', () => {
  it('reads the initial snapshot and exposes writes to later calls in the same action', async () => {
    const controller = createRivetWebAppStorageExternalFunctions({ existing: { value: 1 } });
    const get = controller.externalFunctions[RIVET_WEB_APP_STORAGE_GET_FUNCTION_NAME]!;
    const set = controller.externalFunctions[RIVET_WEB_APP_STORAGE_SET_FUNCTION_NAME]!;
    const context = {} as Parameters<typeof get>[0];

    assert.deepEqual(await get(context, 'existing'), { type: 'any', value: { value: 1 } });
    assert.deepEqual(await get(context, 'missing'), { type: 'any', value: null });
    assert.deepEqual(await set(context, 'preferences', { density: 'compact', sidebarOpen: false }), {
      type: 'any',
      value: { density: 'compact', sidebarOpen: false },
    });
    assert.deepEqual(await get(context, 'preferences'), {
      type: 'any',
      value: { density: 'compact', sidebarOpen: false },
    });
    assert.deepEqual(controller.getStoragePatch(), { preferences: { density: 'compact', sidebarOpen: false } });
    assert.deepEqual(await get(context), {
      type: 'object',
      value: { existing: { value: 1 }, preferences: { density: 'compact', sidebarOpen: false } },
    });
  });

  it('supports general JSON values without exposing mutable internal storage', async () => {
    const controller = createRivetWebAppStorageExternalFunctions({ featureFlags: { beta: false } });
    const get = controller.externalFunctions[RIVET_WEB_APP_STORAGE_GET_FUNCTION_NAME]!;
    const set = controller.externalFunctions[RIVET_WEB_APP_STORAGE_SET_FUNCTION_NAME]!;
    const context = {} as Parameters<typeof get>[0];

    await set(context, 'filters', ['recent', true, null, { maxItems: 20 }]);
    const firstRead = await get(context);
    assert.deepEqual(firstRead, {
      type: 'object',
      value: {
        featureFlags: { beta: false },
        filters: ['recent', true, null, { maxItems: 20 }],
      },
    });

    (firstRead.value as Record<string, { beta: boolean }>).featureFlags!.beta = true;
    assert.deepEqual(await get(context, 'featureFlags'), { type: 'any', value: { beta: false } });

    const patch = controller.getStoragePatch() as { filters: unknown[] };
    patch.filters.push('mutated outside storage');
    assert.deepEqual(controller.getStoragePatch(), {
      filters: ['recent', true, null, { maxItems: 20 }],
    });
  });

  it('rejects invalid keys and non-JSON values', async () => {
    const controller = createRivetWebAppStorageExternalFunctions();
    const set = controller.externalFunctions[RIVET_WEB_APP_STORAGE_SET_FUNCTION_NAME]!;
    const context = {} as Parameters<typeof set>[0];

    await assert.rejects(() => set(context, '', 'value'), /non-empty string/);
    await assert.rejects(() => set(context, 'invalid', undefined), /JSON-serializable/);
  });
});
