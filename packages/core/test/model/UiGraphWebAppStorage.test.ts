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
    assert.deepEqual(await set(context, 'analysis', { summary: 'Stored locally' }), {
      type: 'any',
      value: { summary: 'Stored locally' },
    });
    assert.deepEqual(await get(context, 'analysis'), {
      type: 'any',
      value: { summary: 'Stored locally' },
    });
    assert.deepEqual(controller.getStoragePatch(), { analysis: { summary: 'Stored locally' } });
    assert.deepEqual(await get(context), {
      type: 'object',
      value: { existing: { value: 1 }, analysis: { summary: 'Stored locally' } },
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
