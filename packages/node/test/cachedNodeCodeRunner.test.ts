import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CachedNodeCodeRunner } from '../src/native/CachedNodeCodeRunner.js';
import type { CodeRunnerOptions } from '../src/index.js';

const DEFAULT_OPTIONS: CodeRunnerOptions = {
  includeConsole: false,
  includeFetch: false,
  includeProcess: false,
  includeRequire: false,
  includeRivet: false,
};

void describe('CachedNodeCodeRunner', () => {
  void it('caches compiled code while keeping inputs fresh per invocation', async () => {
    const runner = new CachedNodeCodeRunner();
    const code = "return { output: { type: 'any', value: inputs.input.value + 1 } };";

    const firstOutputs = await runner.runCode(code, { input: { type: 'number', value: 1 } }, DEFAULT_OPTIONS);
    const secondOutputs = await runner.runCode(code, { input: { type: 'number', value: 10 } }, DEFAULT_OPTIONS);

    assert.deepEqual(firstOutputs, { output: { type: 'any', value: 2 } });
    assert.deepEqual(secondOutputs, { output: { type: 'any', value: 11 } });
    assert.deepEqual(runner.getCacheStats(), {
      entries: 1,
      hits: 1,
      misses: 1,
    });
  });

  void it('does not share local variables between invocations', async () => {
    const runner = new CachedNodeCodeRunner();
    const code = `
      let count = 0;
      count += 1;
      return { output: { type: 'number', value: count } };
    `;

    const firstOutputs = await runner.runCode(code, {}, DEFAULT_OPTIONS);
    const secondOutputs = await runner.runCode(code, {}, DEFAULT_OPTIONS);

    assert.deepEqual(firstOutputs, { output: { type: 'number', value: 1 } });
    assert.deepEqual(secondOutputs, { output: { type: 'number', value: 1 } });
    assert.equal(runner.getCacheStats().hits, 1);
  });

  void it('uses the runner-scoped environment without changing the Node process environment', async () => {
    const name = 'RIVET_TEST_SCOPED_EXECUTION_ENVIRONMENT';
    const originalValue = process.env[name];
    process.env[name] = 'physical';

    try {
      const runner = new CachedNodeCodeRunner({ executionEnvironment: { [name]: 'managed' } });
      const outputs = await runner.runCode(
        `
          const replaceEnvironmentResult = Reflect.set(process, 'env', { ${name}: 'replacement' });
          return { output: { type: 'string', value: [process.env.${name}, String(replaceEnvironmentResult)].join('/') } };
        `,
        {},
        { ...DEFAULT_OPTIONS, includeProcess: true },
      );

      assert.deepEqual(outputs, { output: { type: 'string', value: 'managed/false' } });
      assert.equal(process.env[name], 'physical');
    } finally {
      if (originalValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = originalValue;
      }
    }
  });

  void it('separates cached functions by permission argument shape', async () => {
    const runner = new CachedNodeCodeRunner();
    const code = "return { output: { type: 'string', value: typeof require } };";

    const withoutRequire = await runner.runCode(code, {}, DEFAULT_OPTIONS);
    const withRequire = await runner.runCode(code, {}, { ...DEFAULT_OPTIONS, includeRequire: true });
    const withRequireAgain = await runner.runCode(code, {}, { ...DEFAULT_OPTIONS, includeRequire: true });

    assert.deepEqual(withoutRequire, { output: { type: 'string', value: 'undefined' } });
    assert.deepEqual(withRequire, { output: { type: 'string', value: 'function' } });
    assert.deepEqual(withRequireAgain, { output: { type: 'string', value: 'function' } });
    assert.deepEqual(runner.getCacheStats(), {
      entries: 2,
      hits: 1,
      misses: 2,
    });
  });

  void it('separates cached functions by graph input and context argument presence', async () => {
    const runner = new CachedNodeCodeRunner();
    const code = `
      const graphInputValue = typeof graphInputs === 'undefined' ? 'none' : graphInputs.graphInput?.value;
      const contextValue = typeof context === 'undefined' ? 'none' : context.contextValue?.value;
      return {
        output: {
          type: 'string',
          value: String(typeof graphInputs) + ':' + String(typeof context) + ':' + graphInputValue + ':' + contextValue,
        },
      };
    `;

    const withoutExtras = await runner.runCode(code, {}, DEFAULT_OPTIONS);
    const withGraphInputs = await runner.runCode(code, {}, DEFAULT_OPTIONS, {});
    const withGraphInputsAndContext = await runner.runCode(
      code,
      {},
      DEFAULT_OPTIONS,
      { graphInput: { type: 'string', value: 'first' } },
      { contextValue: { type: 'string', value: 'first' } },
    );
    const withGraphInputsAndContextAgain = await runner.runCode(
      code,
      {},
      DEFAULT_OPTIONS,
      { graphInput: { type: 'string', value: 'second' } },
      { contextValue: { type: 'string', value: 'second' } },
    );

    assert.deepEqual(withoutExtras, { output: { type: 'string', value: 'undefined:undefined:none:none' } });
    assert.deepEqual(withGraphInputs, { output: { type: 'string', value: 'object:undefined:undefined:none' } });
    assert.deepEqual(withGraphInputsAndContext, { output: { type: 'string', value: 'object:object:first:first' } });
    assert.deepEqual(withGraphInputsAndContextAgain, {
      output: { type: 'string', value: 'object:object:second:second' },
    });
    assert.deepEqual(runner.getCacheStats(), {
      entries: 3,
      hits: 1,
      misses: 3,
    });
  });

  void it('evicts the oldest compiled functions when the cache is full', async () => {
    const runner = new CachedNodeCodeRunner({ maxEntries: 1 });

    await runner.runCode("return { output: { type: 'number', value: 1 } };", {}, DEFAULT_OPTIONS);
    await runner.runCode("return { output: { type: 'number', value: 2 } };", {}, DEFAULT_OPTIONS);
    await runner.runCode("return { output: { type: 'number', value: 1 } };", {}, DEFAULT_OPTIONS);

    assert.deepEqual(runner.getCacheStats(), {
      entries: 1,
      hits: 0,
      misses: 3,
    });
  });

  void it('can disable compiled-function caching', async () => {
    const runner = new CachedNodeCodeRunner({ maxEntries: 0 });
    const code = "return { output: { type: 'number', value: inputs.input.value } };";

    await runner.runCode(code, { input: { type: 'number', value: 1 } }, DEFAULT_OPTIONS);
    await runner.runCode(code, { input: { type: 'number', value: 2 } }, DEFAULT_OPTIONS);

    assert.deepEqual(runner.getCacheStats(), {
      entries: 0,
      hits: 0,
      misses: 2,
    });
  });

  void it('can clear cached compiled functions without resetting hit/miss history', async () => {
    const runner = new CachedNodeCodeRunner();
    const code = "return { output: { type: 'number', value: 1 } };";

    await runner.runCode(code, {}, DEFAULT_OPTIONS);
    await runner.runCode(code, {}, DEFAULT_OPTIONS);
    runner.clearCache();

    assert.deepEqual(runner.getCacheStats(), {
      entries: 0,
      hits: 1,
      misses: 1,
    });
  });
});
