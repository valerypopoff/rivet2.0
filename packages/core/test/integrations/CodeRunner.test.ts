import assert from 'node:assert/strict';
import test from 'node:test';
import { IsomorphicCodeRunner } from '../../src/index.js';

test('IsomorphicCodeRunner injects the narrow interpolation resolver when requested', async () => {
  const runner = new IsomorphicCodeRunner();
  const outputs = await runner.runCode(
    `
      return {
        output: {
          type: 'any',
          value: __resolveInterpolation(inputs, 'payload.items[0].name'),
        },
      };
    `,
    {
      payload: {
        type: 'object',
        value: { items: [{ name: 'browser-value' }] },
      },
    },
    {
      includeConsole: false,
      includeFetch: false,
      includeProcess: false,
      includeRequire: false,
      includeRivet: false,
      interpolationHelperIdentifier: '__resolveInterpolation',
    },
  );

  assert.deepEqual(outputs, {
    output: {
      type: 'any',
      value: 'browser-value',
    },
  });
});

test('IsomorphicCodeRunner injects a selected global snapshot under its requested identifier', async () => {
  const runner = new IsomorphicCodeRunner();
  const outputs = await runner.runCode(
    `
      return {
        output: {
          type: 'any',
          value: __resolveInterpolation(inputs, '@globals.profile.name', undefined, undefined, __globals),
        },
      };
    `,
    {},
    {
      includeConsole: false,
      includeFetch: false,
      includeProcess: false,
      includeRequire: false,
      includeRivet: false,
      globalValuesIdentifier: '__globals',
      interpolationHelperIdentifier: '__resolveInterpolation',
    },
    undefined,
    undefined,
    {
      profile: { type: 'object', value: { name: 'browser-global' } },
    },
  );

  assert.deepEqual(outputs, {
    output: {
      type: 'any',
      value: 'browser-global',
    },
  });
});
