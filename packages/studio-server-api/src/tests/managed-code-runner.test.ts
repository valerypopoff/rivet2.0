import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createManagedCodeRunnerTelemetry,
  getManagedCodeRunnerCacheSizeForTests,
  getManagedRequireCacheSizeForTests,
  ManagedCodeRunner,
  resetManagedCodeRunnerCacheForTests,
  setManagedCodeRunnerCacheLimitForTests,
} from '../runtime-libraries/managed-code-runner.js';
import { withScopedEnv } from './helpers/runtime-library-harness.js';
import { materializeLocalRuntimeLibraries } from '../local-metadata/runtime-library-authority.js';
import { createRuntimeLibraryDirectoryArchive } from '../scripts/migrate-runtime-libraries.js';

// test-style: fixture-read: reads only generated package-cache fixtures to verify activation and confined cleanup.

const CODE_RUNNER_ENV_KEYS = [
  'RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE',
  'RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE',
] as const;

const plainOptions = {
  includeFetch: false,
  includeRequire: false,
  includeRivet: false,
  includeProcess: false,
  includeConsole: false,
};

const requireOptions = {
  ...plainOptions,
  includeRequire: true,
};

function getOutputValue(output: Record<string, { value?: unknown }>): unknown {
  return output.output?.value;
}

test(
  'SQLite cache link replacement is atomic and a failed promotion preserves the current release',
  { skip: process.platform === 'win32' },
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-atomic-cache-'));
    const current = path.join(root, 'current');
    const state = { manifest: { packages: {}, updatedAt: '' }, archive: null };
    try {
      await materializeLocalRuntimeLibraries(root, state);
      const original = await fs.readlink(current);
      const rename = fs.rename;
      let replacements = 0;
      context.mock.method(fs, 'rename', async (from: string, to: string) => {
        assert.notEqual(
          from,
          current,
          'Live activation cannot remove the current link before promoting the replacement.',
        );
        if (path.basename(from).startsWith('link-') && to === current) {
          assert.equal(await fs.readlink(current), original);
          await rename(from, to);
          assert.notEqual(await fs.readlink(current), original);
          replacements += 1;
        } else await rename(from, to);
      });
      await materializeLocalRuntimeLibraries(root, state);
      assert.equal(replacements, 1);
      context.mock.restoreAll();

      const active = await fs.readlink(current);
      context.mock.method(fs, 'rename', async (from: string, to: string) => {
        if (path.basename(from).startsWith('link-') && to === current)
          throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' });
        return rename(from, to);
      });
      await assert.rejects(materializeLocalRuntimeLibraries(root, state), /synthetic permission failure/);
      assert.equal(await fs.readlink(current), active);
      assert.ok((await fs.stat(path.join(current, 'node_modules'))).isDirectory());
      assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('cache-')).length, 2);
      assert.equal((await fs.readdir(root)).length, 3, 'Failed extraction and pending links are cleaned up.');
    } finally {
      context.mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('SQLite package-cache activation refreshes main/exports and preserves in-flight lazy dependencies until startup', async () => {
  await withRunnerEnv({}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-versioned-cache-'));
    const cache = path.join(root, 'cache');
    let firstRequire: NodeRequire | undefined;
    try {
      for (const [name, value] of [
        ['first', 84],
        ['second', 42],
      ] as const) {
        const stage = path.join(root, name);
        const pkg = path.join(stage, 'node_modules', 'fixture-package');
        await fs.mkdir(pkg, { recursive: true });
        await fs.writeFile(path.join(stage, 'package.json'), '{"private":true}');
        await fs.writeFile(
          path.join(pkg, 'package.json'),
          JSON.stringify({ name: 'fixture-package', main: `${name}.cjs`, exports: { '.': `./${name}.cjs` } }),
        );
        await fs.writeFile(path.join(pkg, `${name}.cjs`), `module.exports=require('./value.cjs');`);
        await fs.writeFile(path.join(pkg, 'value.cjs'), `module.exports=${value};`);
        await materializeLocalRuntimeLibraries(cache, {
          manifest: { packages: { 'fixture-package': { name: 'fixture-package', version: '1.0.0' } }, updatedAt: '' },
          archive: await createRuntimeLibraryDirectoryArchive(stage),
        });
        const runner = new ManagedCodeRunner(cache, { prepareRuntimeLibraries: async () => {} });
        const output = await runner.runCode(
          'return { output: { type: "number", value: require("fixture-package") } };',
          {},
          requireOptions,
        );
        assert.equal(getOutputValue(output), value);
        if (name === 'first') {
          const { createRequire } = await import('node:module');
          firstRequire = createRequire(path.join(await fs.realpath(path.join(cache, 'current')), 'package.json'));
        } else {
          assert.equal(firstRequire!('fixture-package'), 84, 'An older workflow still loads its own dependencies.');
        }
        const entries = await fs.readdir(cache);
        assert.equal(entries.filter((entry) => entry.startsWith('cache-')).length, name === 'first' ? 1 : 2);
      }
      await materializeLocalRuntimeLibraries(
        cache,
        { manifest: { packages: {}, updatedAt: '' }, archive: null },
        { pruneInactive: true },
      );
      assert.equal((await fs.readdir(cache)).length, 2, 'Startup prunes inactive caches before admitting executions.');
      const outside = path.join(root, 'unowned');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'keep'), 'untouched');
      await fs.unlink(path.join(cache, 'current'));
      await fs.symlink(outside, path.join(cache, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        materializeLocalRuntimeLibraries(cache, { manifest: { packages: {}, updatedAt: '' }, archive: null }),
        /unexpected activation link/,
      );
      assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFixturePackage(runtimeLibrariesRoot: string, value: string): Promise<void> {
  const packageRoot = path.join(runtimeLibrariesRoot, 'current', 'node_modules', 'fixture-package');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, 'index.js'),
    `module.exports = { value: ${JSON.stringify(value)} };\n`,
    'utf8',
  );
}

async function writeRuntimeManifest(
  runtimeLibrariesRoot: string,
  manifest: { activeReleaseId?: string; updatedAt?: string },
): Promise<void> {
  await fs.writeFile(
    path.join(runtimeLibrariesRoot, 'manifest.json'),
    JSON.stringify({
      packages: {
        'fixture-package': {
          name: 'fixture-package',
          version: '1.0.0',
        },
      },
      ...manifest,
    }),
    'utf8',
  );
}

async function withRunnerEnv(
  overrides: Partial<Record<(typeof CODE_RUNNER_ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<void>,
): Promise<void> {
  await withScopedEnv(CODE_RUNNER_ENV_KEYS, overrides, async () => {
    resetManagedCodeRunnerCacheForTests();
    try {
      await run();
    } finally {
      resetManagedCodeRunnerCacheForTests();
    }
  });
}

test('plain JS does not prepare runtime libraries', async () => {
  await withRunnerEnv({}, async () => {
    let prepareCalls = 0;
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry,
      prepareRuntimeLibraries: async () => {
        prepareCalls += 1;
      },
    });

    const output = await runner.runCode(
      'return { output: { type: "any", value: inputs.input.value } };',
      { input: { type: 'any', value: 'plain' } },
      plainOptions,
    );

    assert.equal(getOutputValue(output), 'plain');
    assert.equal(prepareCalls, 0);
    assert.equal(telemetry.calls, 1);
    assert.equal(telemetry.prepareCalls, 0);
  });
});

test('Code nodes receive their immutable managed execution environment', async () => {
  const name = 'RIVET_MANAGED_ENVIRONMENT_TEST';
  await withScopedEnv([name], { [name]: 'physical' }, async () => {
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      executionEnvironment: { [name]: 'managed' },
    });

    const output = await runner.runCode(
      `return { output: { type: 'string', value: process.env.${name} } };`,
      {},
      { ...plainOptions, includeProcess: true },
    );

    assert.equal(getOutputValue(output), 'managed');
    assert.equal(process.env[name], 'physical');
  });
});

test('require-enabled code prepares runtime libraries once per runner', async () => {
  await withRunnerEnv({}, async () => {
    let prepareCalls = 0;
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry,
      prepareRuntimeLibraries: async () => {
        prepareCalls += 1;
      },
    });

    const code = 'return { output: { type: "any", value: inputs.input.value } };';
    await runner.runCode(code, { input: { type: 'any', value: 1 } }, requireOptions);
    await runner.runCode(code, { input: { type: 'any', value: 2 } }, requireOptions);

    assert.equal(prepareCalls, 1);
    assert.equal(telemetry.requireCalls, 2);
    assert.equal(telemetry.prepareCalls, 1);
  });
});

test('includeRivet without require does not prepare managed runtime libraries', async () => {
  await withRunnerEnv({}, async () => {
    let prepareCalls = 0;
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry,
      loadRivet: async () => ({ marker: 'rivet-stub' }),
      prepareRuntimeLibraries: async () => {
        prepareCalls += 1;
      },
    });

    const output = await runner.runCode(
      'return { output: { type: "any", value: Rivet.marker } };',
      { input: { type: 'any', value: null } },
      {
        ...plainOptions,
        includeRivet: true,
      },
    );

    assert.equal(getOutputValue(output), 'rivet-stub');
    assert.equal(prepareCalls, 0);
    assert.equal(telemetry.rivetCalls, 1);
    assert.equal(telemetry.prepareCalls, 0);
  });
});

test('compiled cache passes fresh inputs across runner instances', async () => {
  await withRunnerEnv({}, async () => {
    const code = 'return { output: { type: "any", value: inputs.input.value } };';
    const firstTelemetry = createManagedCodeRunnerTelemetry();
    const firstRunner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry: firstTelemetry,
    });

    const firstOutput = await firstRunner.runCode(code, { input: { type: 'any', value: 'first' } }, plainOptions);
    assert.equal(getOutputValue(firstOutput), 'first');
    assert.equal(firstTelemetry.compileCalls, 1);
    assert.equal(firstTelemetry.cacheMisses, 1);

    const secondTelemetry = createManagedCodeRunnerTelemetry();
    const secondRunner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry: secondTelemetry,
    });
    const secondOutput = await secondRunner.runCode(code, { input: { type: 'any', value: 'second' } }, plainOptions);

    assert.equal(getOutputValue(secondOutput), 'second');
    assert.equal(secondTelemetry.compileCalls, 0);
    assert.equal(secondTelemetry.cacheHits, 1);
  });
});

test('compiled cache passes fresh graph inputs and context values', async () => {
  await withRunnerEnv({}, async () => {
    const code = [
      'return {',
      '  output: {',
      '    type: "any",',
      '    value: `${graphInputs.graphValue.value}:${context.contextValue.value}`',
      '  }',
      '};',
    ].join('\n');
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', { telemetry });

    const firstOutput = await runner.runCode(
      code,
      { input: { type: 'any', value: null } },
      plainOptions,
      { graphValue: { type: 'string', value: 'graph-a' } },
      { contextValue: { type: 'string', value: 'context-a' } },
    );
    const secondOutput = await runner.runCode(
      code,
      { input: { type: 'any', value: null } },
      plainOptions,
      { graphValue: { type: 'string', value: 'graph-b' } },
      { contextValue: { type: 'string', value: 'context-b' } },
    );

    assert.equal(getOutputValue(firstOutput), 'graph-a:context-a');
    assert.equal(getOutputValue(secondOutput), 'graph-b:context-b');
    assert.equal(telemetry.compileCalls, 1);
    assert.equal(telemetry.cacheHits, 1);
  });
});

test('different argument shapes do not share compiled functions', async () => {
  await withRunnerEnv({}, async () => {
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', { telemetry });
    const code = 'return { output: { type: "any", value: inputs.input.value } };';

    await runner.runCode(code, { input: { type: 'any', value: 1 } }, plainOptions);
    await runner.runCode(
      code,
      { input: { type: 'any', value: 2 } },
      {
        ...plainOptions,
        includeFetch: true,
      },
    );

    assert.equal(telemetry.compileCalls, 2);
    assert.equal(telemetry.cacheMisses, 2);
    assert.equal(telemetry.cacheHits, 0);
  });
});

test('managed runner injects interpolation resolution without Rivet and caches each helper name separately', async () => {
  await withRunnerEnv({}, async () => {
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', { telemetry });
    const code = `
      const resolver = typeof __resolveA === 'function' ? __resolveA : __resolveB;
      return {
        output: {
          type: 'any',
          value: {
            selected: resolver(inputs, 'payload.items[0].name'),
            shape: [typeof __resolveA, typeof __resolveB],
          },
        },
      };
    `;
    const inputs = {
      payload: {
        type: 'object',
        value: { items: [{ name: 'managed-value' }] },
      },
    };

    const first = await runner.runCode(code, inputs, {
      ...plainOptions,
      interpolationHelperIdentifier: '__resolveA',
    });
    const second = await runner.runCode(code, inputs, {
      ...plainOptions,
      interpolationHelperIdentifier: '__resolveB',
    });
    const third = await runner.runCode(code, inputs, {
      ...plainOptions,
      interpolationHelperIdentifier: '__resolveB',
    });

    assert.deepEqual(getOutputValue(first), {
      selected: 'managed-value',
      shape: ['function', 'undefined'],
    });
    assert.deepEqual(getOutputValue(second), {
      selected: 'managed-value',
      shape: ['undefined', 'function'],
    });
    assert.deepEqual(getOutputValue(third), getOutputValue(second));
    assert.equal(telemetry.prepareCalls, 0);
    assert.equal(telemetry.compileCalls, 2);
    assert.equal(telemetry.cacheHits, 1);
    assert.equal(telemetry.cacheMisses, 2);
  });
});

test('managed runner injects the selected global snapshot for special-root interpolation', async () => {
  await withRunnerEnv({}, async () => {
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test');
    const output = await runner.runCode(
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
        ...plainOptions,
        globalValuesIdentifier: '__globals',
        interpolationHelperIdentifier: '__resolveInterpolation',
      },
      undefined,
      undefined,
      {
        profile: { type: 'object', value: { name: 'managed-global' } },
      },
    );

    assert.equal(getOutputValue(output), 'managed-global');
  });
});

test('syntax errors are not cached', async () => {
  await withRunnerEnv({}, async () => {
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', { telemetry });

    await assert.rejects(
      runner.runCode('return {', { input: { type: 'any', value: null } }, plainOptions),
      SyntaxError,
    );
    await assert.rejects(
      runner.runCode('return {', { input: { type: 'any', value: null } }, plainOptions),
      SyntaxError,
    );

    assert.equal(telemetry.compileCalls, 2);
    assert.equal(telemetry.cacheMisses, 2);
    assert.equal(getManagedCodeRunnerCacheSizeForTests(), 0);
  });
});

test('cache eviction is bounded and deterministic', async () => {
  await withRunnerEnv({}, async () => {
    setManagedCodeRunnerCacheLimitForTests(1);
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', { telemetry });

    await runner.runCode('return { output: { type: "any", value: "a" } };', {}, plainOptions);
    await runner.runCode('return { output: { type: "any", value: "b" } };', {}, plainOptions);
    await runner.runCode('return { output: { type: "any", value: "a" } };', {}, plainOptions);

    assert.equal(getManagedCodeRunnerCacheSizeForTests(), 1);
    assert.equal(telemetry.compileCalls, 3);
    assert.equal(telemetry.cacheHits, 0);
  });
});

test('cache disable and force-prepare rollback flags are independent', async () => {
  await withRunnerEnv({ RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE: 'true' }, async () => {
    let prepareCalls = 0;
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry,
      prepareRuntimeLibraries: async () => {
        prepareCalls += 1;
      },
    });
    const code = 'return { output: { type: "any", value: inputs.input.value } };';

    await runner.runCode(code, { input: { type: 'any', value: 'a' } }, plainOptions);
    await runner.runCode(code, { input: { type: 'any', value: 'b' } }, plainOptions);

    assert.equal(prepareCalls, 0);
    assert.equal(telemetry.cacheEnabled, false);
    assert.equal(telemetry.compileCalls, 2);
    assert.equal(telemetry.cacheHits, 0);
  });

  await withRunnerEnv({ RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE: 'true' }, async () => {
    let prepareCalls = 0;
    const telemetry = createManagedCodeRunnerTelemetry();
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      telemetry,
      prepareRuntimeLibraries: async () => {
        prepareCalls += 1;
      },
    });
    const code = 'return { output: { type: "any", value: inputs.input.value } };';

    await runner.runCode(code, { input: { type: 'any', value: 'a' } }, plainOptions);
    await runner.runCode(code, { input: { type: 'any', value: 'b' } }, plainOptions);

    assert.equal(prepareCalls, 2);
    assert.equal(telemetry.cacheEnabled, true);
    assert.equal(telemetry.compileCalls, 1);
    assert.equal(telemetry.cacheHits, 1);
  });

  await withRunnerEnv({ RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE: 'true' }, async () => {
    let prepareCalls = 0;
    const runner = new ManagedCodeRunner('/tmp/rivet-runtime-libraries-test', {
      prepareRuntimeLibraries: async () => {
        prepareCalls += 1;
      },
    });
    const code = 'return { output: { type: "any", value: inputs.input.value } };';

    await runner.runCode(code, { input: { type: 'any', value: 'a' } }, requireOptions);
    await runner.runCode(code, { input: { type: 'any', value: 'b' } }, requireOptions);

    assert.equal(prepareCalls, 2);
  });
});

test('managed require resolves packages from the runtime-library root', async () => {
  await withRunnerEnv({}, async () => {
    const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-code-runner-'));
    try {
      await writeFixturePackage(runtimeLibrariesRoot, 'from-managed-runtime-library');

      let prepareCalls = 0;
      const runner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {
          prepareCalls += 1;
        },
      });

      const output = await runner.runCode(
        'const fixture = require("fixture-package"); return { output: { type: "any", value: fixture.value } };',
        { input: { type: 'any', value: null } },
        requireOptions,
      );

      assert.equal(getOutputValue(output), 'from-managed-runtime-library');
      assert.equal(prepareCalls, 1);
    } finally {
      await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
    }
  });
});

test('managed require cache follows the active runtime-library manifest snapshot', async () => {
  await withRunnerEnv({}, async () => {
    const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-code-runner-'));

    async function writeRelease(releaseId: string, value: string): Promise<void> {
      await writeFixturePackage(runtimeLibrariesRoot, value);
      await writeRuntimeManifest(runtimeLibrariesRoot, {
        updatedAt: new Date().toISOString(),
        activeReleaseId: releaseId,
      });
    }

    try {
      const code =
        'const fixture = require("fixture-package"); return { output: { type: "any", value: fixture.value } };';
      await writeRelease('release-a', 'from-release-a');
      const firstRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {},
      });
      const firstOutput = await firstRunner.runCode(code, { input: { type: 'any', value: null } }, requireOptions);

      await writeRelease('release-b', 'from-release-b');
      const secondRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {},
      });
      const secondOutput = await secondRunner.runCode(code, { input: { type: 'any', value: null } }, requireOptions);

      assert.equal(getOutputValue(firstOutput), 'from-release-a');
      assert.equal(getOutputValue(secondOutput), 'from-release-b');
      assert.equal(getManagedRequireCacheSizeForTests(), 1);
    } finally {
      await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
    }
  });
});

test('managed require cache uses manifest updatedAt when active release id is absent', async () => {
  await withRunnerEnv({}, async () => {
    const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-code-runner-'));

    try {
      const code =
        'const fixture = require("fixture-package"); return { output: { type: "any", value: fixture.value } };';
      await writeFixturePackage(runtimeLibrariesRoot, 'from-updated-a');
      await writeRuntimeManifest(runtimeLibrariesRoot, { updatedAt: '2026-05-25T00:00:00.000Z' });
      const firstRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {},
      });
      const firstOutput = await firstRunner.runCode(code, { input: { type: 'any', value: null } }, requireOptions);

      await writeFixturePackage(runtimeLibrariesRoot, 'from-updated-b');
      await writeRuntimeManifest(runtimeLibrariesRoot, { updatedAt: '2026-05-25T00:00:01.000Z' });
      const secondRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {},
      });
      const secondOutput = await secondRunner.runCode(code, { input: { type: 'any', value: null } }, requireOptions);

      assert.equal(getOutputValue(firstOutput), 'from-updated-a');
      assert.equal(getOutputValue(secondOutput), 'from-updated-b');
      assert.equal(getManagedRequireCacheSizeForTests(), 1);
    } finally {
      await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
    }
  });
});

test('managed require cache falls back to node_modules timestamp without a usable manifest', async () => {
  await withRunnerEnv({}, async () => {
    const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-code-runner-'));
    const nodeModulesRoot = path.join(runtimeLibrariesRoot, 'current', 'node_modules');

    async function writeTimestampedPackage(value: string, timestamp: Date): Promise<void> {
      await writeFixturePackage(runtimeLibrariesRoot, value);
      await fs.writeFile(path.join(runtimeLibrariesRoot, 'manifest.json'), '{ invalid json', 'utf8');
      await fs.utimes(nodeModulesRoot, timestamp, timestamp);
    }

    try {
      const code =
        'const fixture = require("fixture-package"); return { output: { type: "any", value: fixture.value } };';
      await writeTimestampedPackage('from-tree-a', new Date('2026-05-25T00:00:00.000Z'));
      const firstRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {},
      });
      const firstOutput = await firstRunner.runCode(code, { input: { type: 'any', value: null } }, requireOptions);

      await writeTimestampedPackage('from-tree-b', new Date('2026-05-25T00:00:02.000Z'));
      const secondRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: async () => {},
      });
      const secondOutput = await secondRunner.runCode(code, { input: { type: 'any', value: null } }, requireOptions);

      assert.equal(getOutputValue(firstOutput), 'from-tree-a');
      assert.equal(getOutputValue(secondOutput), 'from-tree-b');
      assert.equal(getManagedRequireCacheSizeForTests(), 1);
    } finally {
      await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
    }
  });
});
