import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodeRunnerRequireAnchorPath, getCodeRunnerRequireRoot } from '../src/index.js';
import { NodeCodeRunner } from '../src/native/NodeCodeRunner.js';

void describe('codeRunnerRequire', () => {
  void it('defaults require resolution to the current working directory', () => {
    assert.equal(getCodeRunnerRequireRoot({}, '/workspace/project'), '/workspace/project');
    assert.equal(
      getCodeRunnerRequireAnchorPath({}, '/workspace/project'),
      join('/workspace/project', '__rivet_node_code_runner__.cjs'),
    );
  });

  void it('uses an explicit require root for hosted runtimes', () => {
    assert.equal(
      getCodeRunnerRequireAnchorPath({ RIVET_CODE_RUNNER_REQUIRE_ROOT: '/data/runtime-libraries/current' }, '/ignored'),
      join('/data/runtime-libraries/current', '__rivet_node_code_runner__.cjs'),
    );
  });

  void it('lets an explicit require anchor override the root', () => {
    assert.equal(
      getCodeRunnerRequireAnchorPath({
        RIVET_CODE_RUNNER_REQUIRE_ANCHOR: '/data/runtime-libraries/current/custom-anchor.cjs',
        RIVET_CODE_RUNNER_REQUIRE_ROOT: '/ignored',
      }),
      '/data/runtime-libraries/current/custom-anchor.cjs',
    );
  });

  void it('NodeCodeRunner resolves require from the configured runtime root', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'rivet-code-runner-require-'));
    const moduleDir = join(runtimeRoot, 'node_modules', 'rivet-runtime-test-module');
    const previousRoot = process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT;

    try {
      await mkdir(moduleDir, { recursive: true });
      await writeFile(join(moduleDir, 'index.js'), `module.exports = 'from-runtime-root';`);

      process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT = runtimeRoot;
      const runner = new NodeCodeRunner();

      const outputs = await runner.runCode(
        `
          const value = require('rivet-runtime-test-module');
          return { output1: { type: 'string', value } };
        `,
        {},
        {
          includeConsole: false,
          includeFetch: false,
          includeProcess: false,
          includeRequire: true,
          includeRivet: false,
        },
      );

      assert.deepEqual(outputs, {
        output1: { type: 'string', value: 'from-runtime-root' },
      });
    } finally {
      if (previousRoot === undefined) {
        delete process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT;
      } else {
        process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT = previousRoot;
      }
      await rm(runtimeRoot, { force: true, recursive: true });
    }
  });

  void it('injects the narrow interpolation resolver without enabling Rivet', async () => {
    const runner = new NodeCodeRunner();
    const outputs = await runner.runCode(
      `
        return {
          output1: {
            type: 'any',
            value: {
              graph: __resolveInterpolation(inputs, '@graphInputs.global.items[1]', graphInputs, context),
              input: __resolveInterpolation(inputs, 'payload.items[0].name', graphInputs, context),
              context: __resolveInterpolation(inputs, '@context.local.active', graphInputs, context),
              global: __resolveInterpolation(inputs, '@globals.profile.name', graphInputs, context, __globals),
            },
          },
        };
      `,
      {
        payload: {
          type: 'object',
          value: { items: [{ name: 'first' }] },
        },
      },
      {
        includeConsole: false,
        includeFetch: false,
        includeProcess: false,
        includeRequire: false,
        includeRivet: false,
        interpolationHelperIdentifier: '__resolveInterpolation',
        globalValuesIdentifier: '__globals',
      },
      {
        global: { type: 'object', value: { items: ['ignored', 'second'] } },
      },
      {
        local: { type: 'object', value: { active: true } },
      },
      {
        profile: { type: 'object', value: { name: 'node-global' } },
      },
    );

    assert.deepEqual(outputs, {
      output1: {
        type: 'any',
        value: {
          context: true,
          graph: 'second',
          global: 'node-global',
          input: 'first',
        },
      },
    });
  });
});
