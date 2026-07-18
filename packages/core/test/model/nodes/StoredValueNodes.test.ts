import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  GetStoredValueNodeImpl,
  RivetStoredValueController,
  SetStoredValueNodeImpl,
  type Inputs,
  type InternalProcessContext,
} from '../../../src/index.js';

function createContext(
  controller = new RivetStoredValueController(),
  signal: AbortSignal = new AbortController().signal,
): InternalProcessContext {
  return {
    getCachedStoredValue: (key) => controller.getCached(key),
    getStoredValue: (key) => controller.get(key),
    setStoredValue: (key, value) => controller.set(key, value),
    signal,
    waitForStoredValue: (key, signal) => controller.waitForSet(key, signal),
  } as InternalProcessContext;
}

describe('Set Stored Value', () => {
  it('offers only portable JSON-compatible data types in both node editors', () => {
    const expected = ['any', 'boolean', 'string', 'number', 'date', 'time', 'datetime', 'object', 'vector'];
    const getAllowedTypes = (editors: Array<{ type: string; allowedDataTypes?: readonly string[] }>) =>
      editors.find((candidate) => candidate.type === 'dataTypeSelector')?.allowedDataTypes;

    assert.deepEqual(
      getAllowedTypes(new SetStoredValueNodeImpl(SetStoredValueNodeImpl.create()).getEditors()),
      expected,
    );
    assert.deepEqual(
      getAllowedTypes(new GetStoredValueNodeImpl(GetStoredValueNodeImpl.create()).getEditors()),
      expected,
    );
  });

  it('places a dynamic Key input before Value', () => {
    const chartNode = SetStoredValueNodeImpl.create();
    chartNode.data.useKeyInput = true;

    assert.deepEqual(
      new SetStoredValueNodeImpl(chartNode).getInputDefinitions().map((input) => input.id),
      ['key', 'value'],
    );
  });

  it('supports dynamic keys and returns previous-value metadata', async () => {
    const controller = new RivetStoredValueController();
    await controller.set('dynamic', null);
    const chartNode = SetStoredValueNodeImpl.create();
    chartNode.data.dataType = 'any';
    chartNode.data.useKeyInput = true;

    const outputs = await new SetStoredValueNodeImpl(chartNode).process(
      {
        key: { type: 'string', value: 'dynamic' },
        value: { type: 'object', value: { saved: true } },
      } as Inputs,
      createContext(controller),
    );

    assert.deepEqual(outputs['saved-value'], { type: 'any', value: { saved: true } });
    assert.deepEqual(outputs['previous-value'], { type: 'any', value: null });
    assert.deepEqual(outputs['had-previous-value'], { type: 'boolean', value: true });
    assert.deepEqual(outputs.key, { type: 'string', value: 'dynamic' });
  });

  it('rejects values outside the portable JSON contract', async () => {
    const chartNode = SetStoredValueNodeImpl.create();
    chartNode.data.dataType = 'any';
    await assert.rejects(
      () =>
        new SetStoredValueNodeImpl(chartNode).process(
          { value: { type: 'any', value: undefined } } as Inputs,
          createContext(),
        ),
      /portable JSON/,
    );
  });

  it('rejects an incompatible object for a number without recursive coercion', async () => {
    const chartNode = SetStoredValueNodeImpl.create();
    chartNode.data.dataType = 'number';

    await assert.rejects(
      () =>
        new SetStoredValueNodeImpl(chartNode).process(
          { value: { type: 'any', value: { not: 'a number' } } } as Inputs,
          createContext(),
        ),
      /Expected value of type number/,
    );
  });

  it('reports an incompatible previous value as the selected type default after saving', async () => {
    const controller = new RivetStoredValueController();
    await controller.set('key', { old: true });
    const chartNode = SetStoredValueNodeImpl.create();
    chartNode.data.dataType = 'number';

    const outputs = await new SetStoredValueNodeImpl(chartNode).process(
      { value: { type: 'number', value: 7 } } as Inputs,
      createContext(controller),
    );

    assert.deepEqual(outputs['saved-value'], { type: 'number', value: 7 });
    assert.deepEqual(outputs['previous-value'], { type: 'number', value: 0 });
    assert.deepEqual(outputs['had-previous-value'], { type: 'boolean', value: true });
    assert.deepEqual(await controller.get('key'), { found: true, value: 7 });
  });
});

describe('Get Stored Value', () => {
  it('defaults Wait off and returns a typed default with Found false', async () => {
    const chartNode = GetStoredValueNodeImpl.create();
    chartNode.data.dataType = 'number';
    assert.equal(chartNode.data.wait, false);

    const outputs = await new GetStoredValueNodeImpl(chartNode).process({} as Inputs, createContext());
    assert.deepEqual(outputs.value, { type: 'number', value: 0 });
    assert.deepEqual(outputs.found, { type: 'boolean', value: false });
  });

  it('returns the selected type default with Found true when a stored value has another type', async () => {
    const controller = new RivetStoredValueController();
    await controller.set('key', { not: 'a number' });
    const chartNode = GetStoredValueNodeImpl.create();
    chartNode.data.dataType = 'number';

    const outputs = await new GetStoredValueNodeImpl(chartNode).process({} as Inputs, createContext(controller));

    assert.deepEqual(outputs.value, { type: 'number', value: 0 });
    assert.deepEqual(outputs.found, { type: 'boolean', value: true });
  });

  it('waits for a Set in the same root-run controller', async () => {
    const controller = new RivetStoredValueController();
    const chartNode = GetStoredValueNodeImpl.create();
    chartNode.data.key = 'later';
    chartNode.data.wait = true;
    const pending = new GetStoredValueNodeImpl(chartNode).process({} as Inputs, createContext(controller));

    await controller.set('later', 'available');
    const outputs = await pending;
    assert.deepEqual(outputs.value, { type: 'string', value: 'available' });
    assert.deepEqual(outputs.found, { type: 'boolean', value: true });
  });

  it('cancels Wait when the root run is aborted', async () => {
    const controller = new RivetStoredValueController();
    const abortController = new AbortController();
    const chartNode = GetStoredValueNodeImpl.create();
    chartNode.data.key = 'later';
    chartNode.data.wait = true;
    const pending = new GetStoredValueNodeImpl(chartNode).process(
      {} as Inputs,
      createContext(controller, abortController.signal),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    abortController.abort(new Error('run cancelled'));
    await assert.rejects(() => pending, /run cancelled/);
  });

  it('loads the backend before returning On Demand and observes later Sets through the synchronous cache', async () => {
    const controller = new RivetStoredValueController({ get: () => 'initial', set() {} });
    const chartNode = GetStoredValueNodeImpl.create();
    chartNode.data.key = 'key';
    chartNode.data.onDemand = true;
    const outputs = await new GetStoredValueNodeImpl(chartNode).process({} as Inputs, createContext(controller));
    const read = outputs.value?.value as () => unknown;

    assert.equal(read(), 'initial');
    await controller.set('key', 'later');
    assert.equal(read(), 'later');
  });
});
