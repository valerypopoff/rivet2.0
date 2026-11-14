import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodeNewNodeImpl,
  CodeNodeImpl,
  type CodeNode,
  type CodeRunnerOptions,
  GraphProcessor,
  GraphInputNodeImpl,
  createBuiltInRegistry,
  type ChartNode,
  type DataValue,
  type GraphId,
  type NodeGraph,
  type NodeId,
  type Outputs,
  type PortId,
  type ProcessContext,
  type Project,
  type ProjectId,
  type Tokenizer,
  resolveProcessSettings,
} from '@valerypopoff/rivet2-core';
import { AppExecutorWorkerCodeRunner } from './AppExecutorWorkerCodeRunner.mjs';
import { AppExecutorCodeWorkerPool, shutdownSharedAppExecutorCodeWorkerPool } from './codeRunnerWorkerPool.mjs';
import { createProcessor as createNodeProcessor } from '@valerypopoff/rivet2-node';
import type { CodeWorkerRunRequest } from './codeRunnerWorkerHost.mjs';

const tokenizer: Tokenizer = {
  on: () => undefined,
  getTokenCountForMessages: async () => 0,
  getTokenCountForString: async () => 0,
};

function testProcessContext(): ProcessContext {
  return {
    codeRunner: new AppExecutorWorkerCodeRunner(),
    settings: resolveProcessSettings(),
    tokenizer,
  };
}

function makeProject(graph: NodeGraph): Project {
  const graphId = graph.metadata!.id!;

  return {
    graphs: {
      [graphId]: graph,
    },
    metadata: {
      description: '',
      id: 'app-executor-worker-test-project' as ProjectId,
      mainGraphId: graphId,
      title: 'App Executor Worker Test Project',
    },
  } as Project;
}

function makeCodeNode(code: string): CodeNode {
  const node = CodeNodeImpl.create();
  node.id = 'code-node' as NodeId;
  node.title = 'Code (legacy)';
  node.data = {
    ...node.data,
    code,
    inputNames: [],
    outputNames: ['output1'],
  };
  return node;
}

function makeCodeNewNode(code: string): ChartNode {
  const node = CodeNewNodeImpl.create();
  node.id = 'code-new-node' as NodeId;
  node.title = 'Code';
  node.data = {
    ...node.data,
    code,
  };
  return node;
}

function makeCodeRunnerEquivalenceProject(code: string): Project {
  const graphInput = GraphInputNodeImpl.create();
  graphInput.id = 'graph-input-node' as NodeId;
  graphInput.data = {
    ...graphInput.data,
    dataType: 'string',
    id: 'local',
  };

  const codeNode = makeCodeNode(code);
  codeNode.data = {
    ...codeNode.data,
    inputNames: ['local'],
    outputNames: ['output1'],
  };

  const graph: NodeGraph = {
    connections: [
      {
        inputId: 'local' as PortId,
        inputNodeId: codeNode.id,
        outputId: 'data' as PortId,
        outputNodeId: graphInput.id,
      },
    ],
    metadata: {
      description: '',
      id: 'code-runner-equivalence-graph' as GraphId,
      name: 'Code Runner Equivalence Graph',
    },
    nodes: [graphInput, codeNode],
  };

  return makeProject(graph);
}

function defaultCodeRunnerOptions(overrides: Partial<CodeRunnerOptions> = {}): CodeRunnerOptions {
  return {
    includeConsole: false,
    includeFetch: false,
    includeProcess: false,
    includeRequire: false,
    includeRivet: false,
    ...overrides,
  };
}

void describe('AppExecutorWorkerCodeRunner execution environment', () => {
  void it('overrides process.env only for one worker execution', async () => {
    const name = 'RIVET_TEST_APP_EXECUTOR_SCOPED_ENVIRONMENT';
    const originalValue = process.env[name];
    process.env[name] = 'physical';

    try {
      const runner = new AppExecutorWorkerCodeRunner(undefined, {
        executionEnvironment: { [name]: 'managed' },
      });
      const outputs = await runner.runCode(
        `
          const replaceEnvironmentResult = Reflect.set(process, 'env', { ${name}: 'replacement' });
          return { output: { type: 'string', value: [process.env.${name}, String(replaceEnvironmentResult)].join('/') } };
        `,
        {},
        defaultCodeRunnerOptions({ includeProcess: true }),
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
});

void after(async () => {
  await shutdownSharedAppExecutorCodeWorkerPool();
});

void describe('AppExecutorWorkerCodeRunner', () => {
  void it('executes authored code on a worker thread', async () => {
    const outputs = await new AppExecutorWorkerCodeRunner().runCode(
      'return {output1:{type:"boolean",value:require("node:worker_threads").isMainThread}};',
      {},
      defaultCodeRunnerOptions({ includeRequire: true }),
    );
    assert.deepEqual(outputs, { output1: { type: 'boolean', value: false } });
  });

  void it('uses a prewarmed worker for the first run when one is available', async () => {
    const pool = new AppExecutorCodeWorkerPool({ size: 1 });

    try {
      await pool.prewarm();
      const runner = new AppExecutorWorkerCodeRunner(undefined, { workerPool: pool });
      const before = pool.getStats();

      const outputs = await runner.runCode(
        `return { output1: { type: 'string', value: 'warm' } };`,
        {},
        defaultCodeRunnerOptions(),
      );
      const after = pool.getStats();

      assert.deepEqual(outputs, {
        output1: { type: 'string', value: 'warm' },
      });
      assert.equal(after.acquiredReadyWorkers, before.acquiredReadyWorkers + 1);
      assert.equal(after.acquiredColdWorkers, before.acquiredColdWorkers);
    } finally {
      await pool.shutdown();
    }
  });

  void it('does not leak global state between worker runs', async () => {
    const pool = new AppExecutorCodeWorkerPool({ size: 1 });

    try {
      await pool.prewarm();
      const runner = new AppExecutorWorkerCodeRunner(undefined, { workerPool: pool });
      const code = `
        globalThis.__rivetCodeRunnerLeak = (globalThis.__rivetCodeRunnerLeak ?? 0) + 1;
        return { output1: { type: 'number', value: globalThis.__rivetCodeRunnerLeak } };
      `;

      const first = await runner.runCode(code, {}, defaultCodeRunnerOptions());
      const second = await runner.runCode(code, {}, defaultCodeRunnerOptions());

      assert.deepEqual(first, {
        output1: { type: 'number', value: 1 },
      });
      assert.deepEqual(second, {
        output1: { type: 'number', value: 1 },
      });
    } finally {
      await pool.shutdown();
    }
  });

  void it('keeps the prepared physical anchor when a worker request waits in a queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivet-queued-release-'));
    const hooks = globalThis as typeof globalThis & {
      __RIVET_PREPARE_RUNTIME_LIBRARIES__?: (force?: boolean) => Promise<unknown>;
    };
    const previous = hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__;
    const realPool = new AppExecutorCodeWorkerPool({ size: 1 });
    let release!: () => void, queued!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      queued = resolve;
    });
    let active = 'A';
    hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => ({
      version: 1,
      requireAnchorPath: join(root, active, 'node_modules', '__rivet.cjs'),
    });
    const pool = {
      run: async (request: CodeWorkerRunRequest) => {
        queued();
        await gate;
        return realPool.run(request);
      },
    } as unknown as AppExecutorCodeWorkerPool;
    let running: Promise<Outputs> | undefined;
    try {
      for (const name of ['A', 'B']) {
        const pkg = join(root, name, 'node_modules', 'example');
        await mkdir(pkg, { recursive: true });
        await writeFile(join(pkg, 'index.js'), `module.exports=${JSON.stringify(name)};`);
      }
      const runner = new AppExecutorWorkerCodeRunner(undefined, { workerPool: pool });
      const code = 'return {output1:{type:"string",value:require("example")}}';
      const options = defaultCodeRunnerOptions({ includeRequire: true });
      running = runner.runCode(code, {}, options);
      await entered;
      active = 'B';
      release();
      assert.equal((await running).output1?.value, 'A');
      assert.equal(
        (await new AppExecutorWorkerCodeRunner(undefined, { workerPool: realPool }).runCode(code, {}, options)).output1
          ?.value,
        'B',
      );
    } finally {
      release();
      await running?.catch(() => {});
      await realPool.shutdown();
      hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects a legacy void preparation hook before invoking Code', async () => {
    const hooks = globalThis as typeof globalThis & { __RIVET_PREPARE_RUNTIME_LIBRARIES__?: () => Promise<unknown> };
    const previous = hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__;
    hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => undefined;
    try {
      await assert.rejects(
        new AppExecutorWorkerCodeRunner().runCode(
          'throw new Error("Code invoked")',
          {},
          defaultCodeRunnerOptions({ includeRequire: true }),
        ),
        /verified snapshot/,
      );
    } finally {
      hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = previous;
    }
  });

  void it('resolves worker require from the configured runtime root', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'rivet-app-executor-require-'));
    const moduleDir = join(runtimeRoot, 'node_modules', 'rivet-worker-test-module');
    const previousRoot = process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT;

    try {
      await mkdir(moduleDir, { recursive: true });
      await writeFile(join(moduleDir, 'index.js'), `module.exports = 'from-worker-runtime-root';`);

      process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT = runtimeRoot;
      const runner = new AppExecutorWorkerCodeRunner();

      const outputs = await runner.runCode(
        `
          const value = require('rivet-worker-test-module');
          return { output1: { type: 'string', value } };
        `,
        {},
        defaultCodeRunnerOptions({ includeRequire: true }),
      );

      assert.deepEqual(outputs, {
        output1: { type: 'string', value: 'from-worker-runtime-root' },
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

  void it('keeps require module cache isolated between worker runs', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'rivet-app-executor-require-cache-'));
    const moduleDir = join(runtimeRoot, 'node_modules', 'rivet-worker-cache-test-module');
    const previousRoot = process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT;
    const pool = new AppExecutorCodeWorkerPool({ size: 1 });

    try {
      await mkdir(moduleDir, { recursive: true });
      await writeFile(
        join(moduleDir, 'index.js'),
        `
          let counter = 0;
          module.exports = () => ++counter;
        `,
      );

      process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT = runtimeRoot;
      await pool.prewarm();
      const runner = new AppExecutorWorkerCodeRunner(undefined, { workerPool: pool });
      const code = `
        const next = require('rivet-worker-cache-test-module');
        return { output1: { type: 'string', value: [next(), next()].join('/') } };
      `;

      const first = await runner.runCode(code, {}, defaultCodeRunnerOptions({ includeRequire: true }));
      const second = await runner.runCode(code, {}, defaultCodeRunnerOptions({ includeRequire: true }));

      assert.deepEqual(first, {
        output1: { type: 'string', value: '1/2' },
      });
      assert.deepEqual(second, {
        output1: { type: 'string', value: '1/2' },
      });
    } finally {
      await pool.shutdown();
      if (previousRoot === undefined) {
        delete process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT;
      } else {
        process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT = previousRoot;
      }
      await rm(runtimeRoot, { force: true, recursive: true });
    }
  });

  void it('passes inputs, graph inputs, and context values into the worker', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    const outputs = await runner.runCode(
      `
        return {
          output1: {
            type: 'string',
            value: [inputs.local.value, graphInputs.global.value, context.ctx.value].join('/'),
          },
        };
      `,
      {
        ['local' as PortId]: { type: 'string', value: 'input' },
      },
      defaultCodeRunnerOptions(),
      {
        global: { type: 'string', value: 'graph' },
      },
      {
        ctx: { type: 'string', value: 'context' },
      },
    );

    assert.deepEqual(outputs, {
      output1: { type: 'string', value: 'input/graph/context' },
    });
  });

  void it('pins the same release for worker and Rivet-capable calls, while a new root sees updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivet-main-thread-release-'));
    const hooks = globalThis as typeof globalThis & { __RIVET_PREPARE_RUNTIME_LIBRARIES__?: () => Promise<unknown> };
    const previousHook = hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__;
    let active = join(directory, 'first');
    let preparations = 0;
    hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async (force) => {
      assert.equal(force, true);
      preparations++;
      return { version: 1, requireAnchorPath: join(active, 'node_modules', '__rivet.cjs') };
    };
    try {
      await mkdir(join(active, 'node_modules', 'example'), { recursive: true });
      await writeFile(join(active, 'node_modules', 'example', 'index.js'), 'module.exports=84;');
      const runner = new AppExecutorWorkerCodeRunner();
      const options = defaultCodeRunnerOptions({ includeRequire: true, includeRivet: true });
      const code = "return { output1: { type: 'number', value: require('example') } };";
      assert.deepEqual(await runner.runCode(code, {}, options), { output1: { type: 'number', value: 84 } });
      const next = join(directory, 'next');
      await mkdir(join(next, 'node_modules', 'example'), { recursive: true });
      await writeFile(join(next, 'node_modules', 'example', 'index.js'), 'module.exports=42;');
      active = next;
      assert.deepEqual(await runner.runCode(code, {}, options), { output1: { type: 'number', value: 84 } });
      assert.deepEqual(await runner.runCode(code, {}, { ...options, includeRivet: false }), {
        output1: { type: 'number', value: 84 },
      });
      assert.equal(preparations, 1);
      assert.deepEqual(await new AppExecutorWorkerCodeRunner().runCode(code, {}, options), {
        output1: { type: 'number', value: 42 },
      });
    } finally {
      hooks.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = previousHook;
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it('resolves interpolation paths inside the worker without moving execution to the Rivet thread', async () => {
    const pool = new AppExecutorCodeWorkerPool({ size: 1 });

    try {
      await pool.prewarm();
      const before = pool.getStats();
      const runner = new AppExecutorWorkerCodeRunner(undefined, { workerPool: pool });
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
          ['payload' as PortId]: {
            type: 'object',
            value: { items: [{ name: 'worker-value' }] },
          },
        },
        defaultCodeRunnerOptions({
          globalValuesIdentifier: '__globals',
          interpolationHelperIdentifier: '__resolveInterpolation',
        }),
        {
          global: { type: 'object', value: { items: ['ignored', 'graph-value'] } },
        },
        {
          local: { type: 'object', value: { active: true } },
        },
        {
          profile: { type: 'object', value: { name: 'worker-global' } },
        },
      );

      assert.deepEqual(outputs, {
        output1: {
          type: 'any',
          value: {
            context: true,
            graph: 'graph-value',
            global: 'worker-global',
            input: 'worker-value',
          },
        },
      });
      assert.equal(pool.getStats().acquiredReadyWorkers, before.acquiredReadyWorkers + 1);
      assert.equal(pool.getStats().acquiredColdWorkers, before.acquiredColdWorkers);
    } finally {
      await pool.shutdown();
    }
  });

  void it('keeps the worker interpolation runtime independent from an authored require root', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'rivet-app-executor-interpolation-root-'));
    const previousRoot = process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT;

    try {
      process.env.RIVET_CODE_RUNNER_REQUIRE_ROOT = runtimeRoot;
      const runner = new AppExecutorWorkerCodeRunner();
      const outputs = await runner.runCode(
        `
          return {
            output1: {
              type: 'any',
              value: __resolveInterpolation(inputs, 'payload[0]'),
            },
          };
        `,
        {
          ['payload' as PortId]: { type: 'any[]', value: ['isolated-value'] },
        },
        defaultCodeRunnerOptions({ interpolationHelperIdentifier: '__resolveInterpolation' }),
      );

      assert.deepEqual(outputs, {
        output1: { type: 'any', value: 'isolated-value' },
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

  void it('resolves interpolation paths on the Rivet-capability current-thread fallback', async () => {
    const runner = new AppExecutorWorkerCodeRunner();
    const outputs = await runner.runCode(
      `
        return {
          output1: {
            type: 'any',
            value: {
              graph: __resolveInterpolation(inputs, '@graphInputs.global.enabled', graphInputs, context),
              input: __resolveInterpolation(inputs, 'payload.items[0].name', graphInputs, context),
              context: __resolveInterpolation(inputs, '@context.local.label', graphInputs, context),
              rivet: typeof Rivet.createProcessor === 'function',
            },
          },
        };
      `,
      {
        ['payload' as PortId]: {
          type: 'object',
          value: { items: [{ name: 'fallback-value' }] },
        },
      },
      defaultCodeRunnerOptions({
        includeRivet: true,
        interpolationHelperIdentifier: '__resolveInterpolation',
      }),
      {
        global: { type: 'object', value: { enabled: true } },
      },
      {
        local: { type: 'object', value: { label: 'fallback-context' } },
      },
    );

    assert.deepEqual(outputs, {
      output1: {
        type: 'any',
        value: {
          context: 'fallback-context',
          graph: true,
          input: 'fallback-value',
          rivet: true,
        },
      },
    });
  });

  void it('matches the default Node runner for worker-safe capabilities', async () => {
    const appExecutorRunner = new AppExecutorWorkerCodeRunner();
    const code = `
      const path = require('node:path');
      const response = await fetch('data:text/plain,fetched');
      return {
        output1: {
          type: 'object',
          value: {
            input: inputs.local.value,
            graph: graphInputs.local.value,
            context: context.ctx.value,
            process: process.release.name,
            require: path.basename('one/two.txt'),
            fetch: await response.text(),
          },
        },
      };
    `;
    const inputs: Record<PortId, DataValue> = {
      ['local' as PortId]: { type: 'string', value: 'input' },
    };
    const options = defaultCodeRunnerOptions({
      includeFetch: true,
      includeProcess: true,
      includeRequire: true,
    });
    const graphInputs: Record<string, DataValue> = {
      local: { type: 'string', value: 'input' },
    };
    const contextValues: Record<string, DataValue> = {
      ctx: { type: 'string', value: 'context' },
    };
    let nodeOutputs: Outputs | undefined;

    const nodeProcessor = createNodeProcessor(makeCodeRunnerEquivalenceProject(code), {
      context: {
        ctx: 'context',
      },
      graph: 'code-runner-equivalence-graph',
      inputs: {
        local: 'input',
      },
      onNodeFinish: ({ node, outputs }) => {
        if (node.id === 'code-node') {
          nodeOutputs = outputs;
        }
      },
      runtimeProfile: 'compatible',
    });
    await nodeProcessor.run();
    const appExecutorOutputs = await appExecutorRunner.runCode(code, inputs, options, graphInputs, contextValues);

    assert.deepEqual(appExecutorOutputs, nodeOutputs);
    assert.deepEqual(appExecutorOutputs, {
      output1: {
        type: 'object',
        value: {
          context: 'context',
          fetch: 'fetched',
          graph: 'input',
          input: 'input',
          process: 'node',
          require: 'two.txt',
        },
      },
    });
  });

  void it('supports fetch inside the worker', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    const outputs = await runner.runCode(
      `
        const response = await fetch('data:text/plain,hello');
        return { output1: { type: 'string', value: await response.text() } };
      `,
      {},
      defaultCodeRunnerOptions({ includeFetch: true }),
    );

    assert.deepEqual(outputs, {
      output1: { type: 'string', value: 'hello' },
    });
  });

  void it('supports process inside the worker', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    const outputs = await runner.runCode(
      `return { output1: { type: 'string', value: process.release.name } };`,
      {},
      defaultCodeRunnerOptions({ includeProcess: true }),
    );

    assert.deepEqual(outputs, {
      output1: { type: 'string', value: 'node' },
    });
  });

  void it('bridges console output from the worker', async () => {
    const messages: unknown[][] = [];
    const runner = new AppExecutorWorkerCodeRunner((message) => {
      messages.push([message.level, ...message.args]);
    });

    const outputs = await runner.runCode(
      `
        console.log('worker log', { value: 1 });
        console.warn('worker warning');
        return { output1: { type: 'string', value: 'done' } };
      `,
      {},
      defaultCodeRunnerOptions({ includeConsole: true }),
    );

    assert.deepEqual(outputs, {
      output1: { type: 'string', value: 'done' },
    });
    assert.deepEqual(messages, [
      ['log', 'worker log', '{ value: 1 }'],
      ['warn', 'worker warning'],
    ]);
  });

  void it('falls back to current-thread execution for Rivet capability', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    const outputs = await runner.runCode(
      `return { output1: { type: 'boolean', value: typeof Rivet.createProcessor === 'function' } };`,
      {},
      defaultCodeRunnerOptions({ includeRivet: true }),
    );

    assert.deepEqual(outputs, {
      output1: { type: 'boolean', value: true },
    });
  });

  void it('bridges console output from the Rivet-capability fallback runner', async () => {
    const messages: unknown[][] = [];
    const runner = new AppExecutorWorkerCodeRunner((message) => {
      messages.push([message.level, ...message.args]);
    });

    const outputs = await runner.runCode(
      `
        console.info('fallback log', [1, 2]);
        return { output1: { type: 'boolean', value: typeof Rivet.createProcessor === 'function' } };
      `,
      {},
      defaultCodeRunnerOptions({ includeConsole: true, includeRivet: true }),
    );

    assert.deepEqual(outputs, {
      output1: { type: 'boolean', value: true },
    });
    assert.deepEqual(messages, [['info', 'fallback log', '[ 1, 2 ]']]);
  });

  void it('propagates worker errors with readable messages', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    await assert.rejects(
      () => runner.runCode(`throw new TypeError('worker boom');`, {}, defaultCodeRunnerOptions()),
      (error) => error instanceof TypeError && error.message === 'worker boom',
    );
  });

  void it('propagates worker syntax errors with readable messages', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    await assert.rejects(
      () => runner.runCode(`const broken = ;`, {}, defaultCodeRunnerOptions()),
      (error) => error instanceof SyntaxError,
    );
  });

  void it('rejects when a worker exits before returning outputs', async () => {
    const runner = new AppExecutorWorkerCodeRunner();

    await assert.rejects(
      () => runner.runCode(`process.exit(0);`, {}, defaultCodeRunnerOptions({ includeProcess: true })),
      /Code worker exited before returning outputs/,
    );
  });

  void it('still lets the Code (legacy) node validate returned output shape', async () => {
    const graph: NodeGraph = {
      connections: [],
      metadata: {
        description: '',
        id: 'worker-validation-graph' as GraphId,
        name: 'Worker Validation Graph',
      },
      nodes: [makeCodeNode(`return {};`)],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata!.id!, createBuiltInRegistry());
    processor.executor = 'nodejs';

    await assert.rejects(
      () => processor.processGraph(testProcessContext()),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof Error);
        assert.match(
          error.cause.message,
          /Code \(legacy\) node must return an object with output values for all outputs/,
        );
        return true;
      },
    );
  });

  void it('preserves Code (legacy) node error-location enrichment through worker errors', async () => {
    const graph: NodeGraph = {
      connections: [],
      metadata: {
        description: '',
        id: 'worker-error-location-graph' as GraphId,
        name: 'Worker Error Location Graph',
      },
      nodes: [
        makeCodeNode(
          [
            'const first = 1;',
            'const second = 2;',
            'const value = missingVariable;',
            'return { output1: { type: "number", value } };',
          ].join('\n'),
        ),
      ],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata!.id!, createBuiltInRegistry());
    processor.executor = 'nodejs';

    await assert.rejects(
      () => processor.processGraph(testProcessContext()),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof ReferenceError);
        assert.match(error.cause.message, /missingVariable is not defined/);
        assert.match(error.cause.message, /Code \(legacy\) node line 3, column \d+/);
        return true;
      },
    );
  });

  void it('runs Code direct returned values through worker execution', async () => {
    const graph: NodeGraph = {
      connections: [],
      metadata: {
        description: '',
        id: 'worker-code-new-output-graph' as GraphId,
        name: 'Worker Code Output Graph',
      },
      nodes: [makeCodeNewNode('return undefined;')],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata!.id!, createBuiltInRegistry());
    processor.executor = 'nodejs';

    let codeNewOutputs: Outputs | undefined;
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.id === 'code-new-node') {
        codeNewOutputs = outputs;
      }
    });

    await processor.processGraph(testProcessContext());

    assert.deepEqual(codeNewOutputs?.['output' as PortId], {
      type: 'any',
      value: undefined,
    } satisfies DataValue);
  });

  void it('preserves Code error-location enrichment through worker errors', async () => {
    const graph: NodeGraph = {
      connections: [],
      metadata: {
        description: '',
        id: 'worker-code-new-error-location-graph' as GraphId,
        name: 'Worker Code Error Location Graph',
      },
      nodes: [makeCodeNewNode(['const first = 1;', 'const second = 2;', 'return missingVariable;'].join('\n'))],
    };
    const processor = new GraphProcessor(makeProject(graph), graph.metadata!.id!, createBuiltInRegistry());
    processor.executor = 'nodejs';

    await assert.rejects(
      () => processor.processGraph(testProcessContext()),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof ReferenceError);
        assert.match(error.cause.message, /missingVariable is not defined/);
        assert.match(error.cause.message, /Code node line 3, column \d+/);
        return true;
      },
    );
  });
});
