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
import {
  initializeLocalRuntimeLibraryAuthority,
  materializeLocalRuntimeLibraries,
} from '../local-metadata/runtime-library-authority.js';
import { LocalWorkflowCatalog, type LocalRuntimeLibraryState } from '../local-metadata/workflow-catalog.js';
import type { LocalMetadataServingSelection } from '../local-metadata/serving-selection.js';
import { createRuntimeLibraryDirectoryArchive } from '../scripts/migrate-runtime-libraries.js';
import {
  prepareFilesystemRuntimeSnapshot,
  publishRuntimeLibraryCandidate,
  readRuntimeSnapshotLink,
} from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import { CodeNodeImpl, StartBackgroundBranchNodeImpl, createProcessor, type PortId } from '@valerypopoff/rivet2-node';
import { projectBundleFixture } from './helpers/project-bundle-fixture.js';

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

test('new physical releases stay isolated even without release IDs or changed timestamps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-pinned-library-'));
  await withScopedEnv(['RIVET_RUNTIME_LIBRARIES_ROOT'], { RIVET_RUNTIME_LIBRARIES_ROOT: root }, async () => {
    resetManagedCodeRunnerCacheForTests();
    const activate = async (version: string) => {
      const candidate = path.join(root, `candidate-${version}`);
      const pkg = path.join(candidate, 'node_modules', 'fixture-package');
      await fs.mkdir(pkg, { recursive: true });
      await fs.writeFile(path.join(candidate, 'package.json'), '{"private":true}');
      await fs.writeFile(
        path.join(pkg, 'index.js'),
        `exports.late=()=>require('./late.js'); exports.state=()=>require('./state.js');`,
      );
      await fs.writeFile(path.join(pkg, 'late.js'), `module.exports=${JSON.stringify(version)};`);
      await fs.writeFile(path.join(pkg, 'state.js'), `module.exports={version:${JSON.stringify(version)},count:0};`);
      await publishRuntimeLibraryCandidate(root, candidate, {
        packages: { 'fixture-package': { name: 'fixture-package', version: '1.0.0' } },
        updatedAt: '2026-05-25T00:00:00.000Z',
      });
    };
    try {
      await activate('A');
      const first = new ManagedCodeRunner(root, {
        prepareRuntimeLibraries: () => prepareFilesystemRuntimeSnapshot(root),
      });
      const code = 'return {output:{type:"any",value:require("fixture-package")}};';
      const old = (await first.runCode(code, {}, requireOptions)).output!.value as {
        late(): string;
        state(): { count: number };
      };
      const state = old.state();
      state.count = 7;
      await activate('B');
      const second = new ManagedCodeRunner(root, {
        prepareRuntimeLibraries: () => prepareFilesystemRuntimeSnapshot(root),
      });
      const next = (await second.runCode(code, {}, requireOptions)).output!.value as { late(): string };
      assert.equal(next.late(), 'B');
      assert.equal(old.late(), 'A');
      assert.equal(old.state(), state);
      assert.equal(old.state().count, 7);
      assert.equal(getManagedRequireCacheSizeForTests(), 2);
    } finally {
      resetManagedCodeRunnerCacheForTests();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function getOutputValue(output: Record<string, { value?: unknown }>): unknown {
  return output.output?.value;
}

test('SQLite authority restart preserves a surviving executor and reuses the unchanged active cache', async () => {
  await withRunnerEnv({}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-library-restart-'));
    const selection: LocalMetadataServingSelection = {
      generationId: 'fixture',
      source: {
        workflows: path.join(root, 'workflows'),
        recordings: path.join(root, 'recordings'),
        appData: path.join(root, 'app-data'),
        runtimeLibraries: path.join(root, 'legacy-libraries'),
      },
      catalogDatabasePath: path.join(root, 'catalog.sqlite'),
      settingsDatabasePath: path.join(root, 'settings.sqlite'),
      artifactRoot: path.join(root, 'objects'),
      operationalRoot: path.join(root, 'operational'),
      runtimeCacheRoot: path.join(root, 'cache'),
    };
    const catalog = new LocalWorkflowCatalog({
      databasePath: selection.catalogDatabasePath,
      artifactRoot: selection.artifactRoot,
    });
    let dispose: (() => void) | undefined;
    try {
      const release = async (version: string): Promise<LocalRuntimeLibraryState> => {
        const stage = path.join(root, version);
        const pkg = path.join(stage, 'node_modules', 'fixture-package');
        await fs.mkdir(pkg, { recursive: true });
        await fs.writeFile(path.join(stage, 'package.json'), '{"private":true}');
        await fs.writeFile(path.join(pkg, 'index.js'), "module.exports=()=>require('./late.js');");
        await fs.writeFile(path.join(pkg, 'late.js'), `module.exports=${JSON.stringify(version)};`);
        return {
          manifest: {
            packages: { 'fixture-package': { name: 'fixture-package', version } },
            updatedAt: '',
            activeReleaseId: version,
          },
          archive: await createRuntimeLibraryDirectoryArchive(stage),
        };
      };
      const first = await release('A');
      const second = await release('B');
      catalog.initialize();
      await catalog.importRuntimeLibraryState(first);
      dispose = await initializeLocalRuntimeLibraryAuthority(selection, () => {});
      const { createRequire } = await import('node:module');
      const oldSnapshot = readRuntimeSnapshotLink(selection.runtimeCacheRoot);
      const oldModule = createRequire(oldSnapshot.requireAnchorPath)('fixture-package') as () => string;
      dispose();
      dispose = undefined;
      await catalog.replaceRuntimeLibraryState(first, second);
      dispose = await initializeLocalRuntimeLibraryAuthority(selection, () => {});
      assert.equal(oldModule(), 'A', 'A surviving executor must be able to load a dependency after API restart.');
      const active = readRuntimeSnapshotLink(selection.runtimeCacheRoot);
      assert.equal(createRequire(active.requireAnchorPath)('fixture-package')(), 'B');
      dispose();
      dispose = await initializeLocalRuntimeLibraryAuthority(selection, () => {});
      assert.equal(readRuntimeSnapshotLink(selection.runtimeCacheRoot).directory, active.directory);
      assert.equal(
        (await fs.readdir(selection.runtimeCacheRoot)).filter((name) => name.startsWith('cache-')).length,
        2,
      );
      const markerFile = path.join(active.directory, '.rivet-runtime-release.json');
      const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
      marker.packages = {};
      await fs.writeFile(markerFile, JSON.stringify(marker));
      dispose();
      dispose = await initializeLocalRuntimeLibraryAuthority(selection, () => {});
      const repaired = readRuntimeSnapshotLink(selection.runtimeCacheRoot);
      assert.notEqual(repaired.directory, active.directory, 'A cache unreadable by the executor must be rebuilt.');
      assert.equal(createRequire(repaired.requireAnchorPath)('fixture-package')(), 'B');
    } finally {
      dispose?.();
      catalog.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

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
      await materializeLocalRuntimeLibraries(root, {
        ...state,
        manifest: { ...state.manifest, activeReleaseId: 'second' },
      });
      assert.equal(replacements, 1);
      context.mock.restoreAll();

      const active = await fs.readlink(current);
      context.mock.method(fs, 'rename', async (from: string, to: string) => {
        if (path.basename(from).startsWith('link-') && to === current)
          throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' });
        return rename(from, to);
      });
      await assert.rejects(
        materializeLocalRuntimeLibraries(root, { ...state, manifest: { ...state.manifest, activeReleaseId: 'third' } }),
        /synthetic permission failure/,
      );
      assert.equal(await fs.readlink(current), active);
      assert.ok((await fs.stat(path.join(current, 'node_modules'))).isDirectory());
      assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('cache-')).length, 2);
      assert.equal((await fs.readdir(root)).length, 4, 'Only completed caches, current and jobs remain.');
    } finally {
      context.mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('SQLite package-cache activation refreshes main/exports and retains in-flight dependencies', async () => {
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
        const runner = new ManagedCodeRunner(cache, {
          prepareRuntimeLibraries: async () => readRuntimeSnapshotLink(cache),
        });
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
      await materializeLocalRuntimeLibraries(cache, { manifest: { packages: {}, updatedAt: '' }, archive: null });
      assert.equal(
        (await fs.readdir(cache)).filter((name) => name.startsWith('cache-')).length,
        3,
        'An empty activation also retains caches that an older executor may still need.',
      );
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
  await fs.writeFile(path.join(runtimeLibrariesRoot, 'current', 'package.json'), '{"private":true}');
  await writeRuntimeManifest(runtimeLibrariesRoot, {});
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
        return null;
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
        return null;
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
        return null;
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

test('compiled functions reuse code without retaining inputs, context or globals', async () => {
  await withRunnerEnv({}, async () => {
    const telemetry = createManagedCodeRunnerTelemetry();
    const code =
      'return {output:{type:"any",value:[inputs.input.value,graphInputs.input.value,context.input.value,globals.input.value]}};';
    for (const marker of ['first', 'second']) {
      const runner = new ManagedCodeRunner('/unused', { telemetry });
      const values = { input: { type: 'string' as const, value: marker } };
      const output = await runner.runCode(
        code,
        values,
        { ...plainOptions, globalValuesIdentifier: 'globals' },
        values,
        values,
        values,
      );
      assert.deepEqual(getOutputValue(output), [marker, marker, marker, marker]);
    }
    assert.equal(telemetry.compileCalls, 1);
    assert.equal(telemetry.cacheMisses, 1);
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
        return null;
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
        return null;
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
        return null;
      },
    });
    const code = 'return { output: { type: "any", value: inputs.input.value } };';

    await runner.runCode(code, { input: { type: 'any', value: 'a' } }, requireOptions);
    await runner.runCode(code, { input: { type: 'any', value: 'b' } }, requireOptions);

    assert.equal(prepareCalls, 2);
  });
});

test('a corrupt hosted manifest fails before Code and can be repaired before binding', async () => {
  await withRunnerEnv({}, async () => {
    const runtimeLibrariesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-managed-code-runner-'));
    try {
      const code =
        'const fixture = require("fixture-package"); return { output: { type: "any", value: fixture.value } };';
      await writeFixturePackage(runtimeLibrariesRoot, 'repaired');
      await fs.writeFile(path.join(runtimeLibrariesRoot, 'manifest.json'), '{ invalid json', 'utf8');
      const firstRunner = new ManagedCodeRunner(runtimeLibrariesRoot, {
        prepareRuntimeLibraries: () => prepareFilesystemRuntimeSnapshot(runtimeLibrariesRoot),
      });
      await assert.rejects(firstRunner.runCode(code, {}, requireOptions), SyntaxError);
      assert.equal(getManagedRequireCacheSizeForTests(), 0);
      await writeRuntimeManifest(runtimeLibrariesRoot, {});
      assert.equal(getOutputValue(await firstRunner.runCode(code, {}, requireOptions)), 'repaired');
    } finally {
      await fs.rm(runtimeLibrariesRoot, { recursive: true, force: true });
    }
  });
});

test('an initially empty snapshot remains empty after the first package is installed', async () => {
  await withRunnerEnv({}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-empty-snapshot-'));
    try {
      const runner = () =>
        new ManagedCodeRunner(root, { prepareRuntimeLibraries: () => prepareFilesystemRuntimeSnapshot(root) });
      const old = runner();
      await old.runCode(
        'return {output:{type:"string",value:require("node:path").basename("a/b")}}',
        {},
        requireOptions,
      );
      await writeFixturePackage(root, 'new');
      const code = 'return {output:{type:"string",value:require("fixture-package").value}}';
      assert.equal(getOutputValue(await runner().runCode(code, {}, requireOptions)), 'new');
      await assert.rejects(old.runCode(code, {}, requireOptions), /Cannot find module/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

test('concurrent first uses share one preparation and a missing descriptor never invokes Code', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runner = new ManagedCodeRunner('/unused', {
    prepareRuntimeLibraries: async () => {
      calls++;
      await waiting;
      return null;
    },
  });
  const code = 'return {output:{type:"string",value:require("node:path").basename("a/b")}}';
  const first = runner.runCode(code, {}, requireOptions);
  const second = runner.runCode(code, {}, requireOptions);
  assert.equal(calls, 1);
  release();
  assert.equal(getOutputValue(await first), 'b');
  assert.equal(getOutputValue(await second), 'b');
  const invalid = new ManagedCodeRunner('/unused', { prepareRuntimeLibraries: (async () => undefined) as never });
  await assert.rejects(
    invalid.runCode('throw new Error("Code should not run")', {}, requireOptions),
    /verified snapshot/,
  );
});

for (const mode of ['cross-project Subgraph', 'post-response background'] as const) {
  test(`${mode} work inherits its root's library snapshot`, { timeout: 15_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-root-snapshot-'));
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    let processor: ReturnType<typeof createProcessor> | undefined;
    try {
      await writeFixturePackage(root, 'A');
      const codeRunner = new ManagedCodeRunner(root, {
        prepareRuntimeLibraries: async () => {
          calls++;
          return prepareFilesystemRuntimeSnapshot(root);
        },
        loadRivet: async () => ({
          hold: async () => {
            entered();
            await held;
          },
        }),
      });
      const fixture = projectBundleFixture();
      const project = mode === 'cross-project Subgraph' ? fixture.root.project : fixture.child.project;
      const child = fixture.child.project;
      const graph = child.graphs[child.metadata.mainGraphId!]!;
      const oldText = graph.nodes.find((node) => node.type === 'text')!;
      const code = CodeNodeImpl.create();
      code.id = oldText.id;
      code.data = {
        inputNames: [],
        outputNames: ['output'],
        code: 'return {output:{type:"string",value:require("fixture-package").value}};',
      };
      graph.nodes[graph.nodes.indexOf(oldText)] = code;
      let tailId = code.id;
      if (mode === 'cross-project Subgraph') code.data.code = 'await Rivet.hold(); ' + code.data.code;
      else {
        const trigger = StartBackgroundBranchNodeImpl.create();
        const tail = CodeNodeImpl.create();
        tail.data = { ...code.data, inputNames: ['input'], code: 'await Rivet.hold(); ' + code.data.code };
        tailId = tail.id;
        graph.nodes.push(trigger, tail);
        graph.connections.push(
          { outputNodeId: code.id, outputId: 'output' as PortId, inputNodeId: trigger.id, inputId: 'input1' as PortId },
          { outputNodeId: trigger.id, outputId: 'output1' as PortId, inputNodeId: tail.id, inputId: 'input' as PortId },
        );
      }
      processor = createProcessor(project, {
        codeRunner,
        returnWhenGraphOutputsReady: true,
        subgraphProjectLoader: { loadTarget: async () => ({ project: child }) },
      });
      let tailResult: unknown;
      processor.processor.on('nodeFinish', ({ node, outputs }) => {
        if (node.id === tailId) tailResult = outputs['output' as PortId]?.value;
      });
      const foreground = processor.run();
      await started;
      if (mode === 'post-response background') assert.equal((await foreground).result?.value, 'A');
      await writeFixturePackage(root, 'B');
      const next = new ManagedCodeRunner(root, {
        prepareRuntimeLibraries: () => prepareFilesystemRuntimeSnapshot(root),
      });
      assert.equal(
        getOutputValue(
          await next.runCode(
            'return {output:{type:"string",value:require("fixture-package").value}}',
            {},
            requireOptions,
          ),
        ),
        'B',
      );
      release();
      await foreground;
      await processor.processor.waitForRunCompletion();
      assert.equal(tailResult, 'A');
      assert.equal(calls, 1);
    } finally {
      release();
      await processor?.processor.waitForRunCompletion().catch(() => {});
      processor?.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
