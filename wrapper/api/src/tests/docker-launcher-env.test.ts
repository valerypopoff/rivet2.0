import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const launcherEnv = await import(new URL('../../../../scripts/lib/docker-launcher-env.mjs', import.meta.url).href) as {
  assertNoRetiredEnv: (env: NodeJS.ProcessEnv, options?: { launcherName?: string; envFileLabel?: string }) => void;
  dropAmbientNodeOptionsForDocker: (
    env: NodeJS.ProcessEnv,
    fileEnv?: Record<string, string>,
  ) => NodeJS.ProcessEnv;
  listActiveRetiredEnv: (env: NodeJS.ProcessEnv) => string[];
};
const devEnv = await import(new URL('../../../../scripts/lib/dev-env.mjs', import.meta.url).href) as {
  loadDevEnv: (rootDir: string) => {
    envPath: string;
    hasEnvFile: boolean;
    fileEnv: Record<string, string>;
    mergedEnv: NodeJS.ProcessEnv;
  };
};
const rivetSourceContext = await import(new URL('../../../../scripts/lib/rivet-source-context.mjs', import.meta.url).href) as {
  prepareRivetDockerContext: (rootDir: string, env: NodeJS.ProcessEnv) => string;
};

function writeFile(pathname: string, contents: string) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents);
}

function writeMinimalRivetSource(
  sourceRoot: string,
  options: {
    includeBuildWrapperTarget?: boolean;
    scripts?: Record<string, string>;
  } = {},
) {
  const includeBuildWrapperTarget = options.includeBuildWrapperTarget ?? true;
  const scripts = options.scripts ?? {
    'build:runtime': 'node scripts/build-wrapper-target.mjs runtime',
    'build:hosted-web-deps': 'node scripts/build-wrapper-target.mjs hosted-web-deps',
  };

  writeFile(
    path.join(sourceRoot, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'], scripts }, null, 2),
  );
  writeFile(path.join(sourceRoot, 'yarn.lock'), '');
  writeFile(path.join(sourceRoot, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-4.6.0.cjs\n');
  writeFile(path.join(sourceRoot, '.yarn', 'releases', 'yarn-4.6.0.cjs'), '');

  for (const packageName of ['app', 'app-executor', 'core', 'node', 'trivet']) {
    writeFile(path.join(sourceRoot, 'packages', packageName, 'package.json'), JSON.stringify({ name: packageName }));
  }

  if (includeBuildWrapperTarget) {
    writeFile(path.join(sourceRoot, 'scripts', 'build-wrapper-target.mjs'), 'console.log("build target");\n');
    writeFile(path.join(sourceRoot, 'scripts', 'ci-timing.mjs'), 'export function startTimer() { return 0; }\n');
  }
}

function withMutedConsoleLog<T>(callback: () => T): T {
  const originalConsoleLog = console.log;
  console.log = () => {};

  try {
    return callback();
  } finally {
    console.log = originalConsoleLog;
  }
}

function setProcessEnvForTest(name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;

  return () => {
    if (previous == null) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

test('storage launcher env does not activate the managed workflow compose profile', () => {
  const env: NodeJS.ProcessEnv = {
    RIVET_STORAGE_MODE: 'managed',
    RIVET_DATABASE_MODE: 'local-docker',
    COMPOSE_PROFILES: 'alpha',
  };

  assert.equal(env.COMPOSE_PROFILES, 'alpha');
});

test('launcher env helpers report retired aliases with launcher-specific context', () => {
  const env: NodeJS.ProcessEnv = {
    RIVET_STORAGE_BACKEND: 'managed',
    RIVET_DOCKER_WAIT_TIMEOUT: '1200',
  };

  assert.deepEqual(launcherEnv.listActiveRetiredEnv(env), [
    'RIVET_STORAGE_BACKEND -> Settings -> Storage',
    'RIVET_DOCKER_WAIT_TIMEOUT -> Settings -> Docker',
  ]);
  assert.throws(
    () => launcherEnv.assertNoRetiredEnv(env, { launcherName: 'dev-docker', envFileLabel: '.env.compat' }),
    /\[dev-docker\] Retired environment variable\(s\) detected in \.env\.compat: RIVET_STORAGE_BACKEND -> Settings -> Storage, RIVET_DOCKER_WAIT_TIMEOUT -> Settings -> Docker/,
  );
});

test('loadDevEnv honors explicit RIVET_ENV_FILE overrides and still derives filesystem host paths', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-dev-env-'));
  const envPath = path.join(tempRoot, 'compat.env');
  fs.writeFileSync(envPath, [
    'RIVET_ARTIFACTS_HOST_PATH=./artifacts',
  ].join('\n'));

  const restoreEnvFile = setProcessEnvForTest('RIVET_ENV_FILE', envPath);

  try {
    const loaded = devEnv.loadDevEnv(tempRoot);

    assert.equal(loaded.envPath, envPath);
    assert.equal(loaded.hasEnvFile, true);
    assert.equal(
      loaded.mergedEnv.RIVET_SOURCE_BUILD_CONTEXT_PATH,
      path.join(tempRoot, '.data', 'docker-contexts', 'rivet-source'),
    );
    assert.equal(
      loaded.mergedEnv.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH,
      path.join(tempRoot, '.data', 'docker-contexts', 'rivet-dependency-metadata'),
    );
    assert.equal(loaded.mergedEnv.RIVET_WORKFLOWS_HOST_PATH, path.join(tempRoot, 'artifacts', 'workflows'));
    assert.equal(loaded.mergedEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH, path.join(tempRoot, 'artifacts', 'workflow-recordings'));
    assert.equal(loaded.mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH, path.join(tempRoot, 'artifacts', 'runtime-libraries'));
  } finally {
    restoreEnvFile();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('loadDevEnv preserves an explicit workflow recordings host path override', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-dev-env-recordings-'));
  const envPath = path.join(tempRoot, 'compat.env');
  fs.writeFileSync(envPath, [
    'RIVET_ARTIFACTS_HOST_PATH=./artifacts',
    'RIVET_WORKFLOW_RECORDINGS_HOST_PATH=./custom-recordings',
  ].join('\n'));

  const restoreEnvFile = setProcessEnvForTest('RIVET_ENV_FILE', envPath);

  try {
    const loaded = devEnv.loadDevEnv(tempRoot);

    assert.equal(loaded.mergedEnv.RIVET_WORKFLOWS_HOST_PATH, path.join(tempRoot, 'artifacts', 'workflows'));
    assert.equal(loaded.mergedEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH, path.join(tempRoot, 'custom-recordings'));
    assert.equal(loaded.mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH, path.join(tempRoot, 'artifacts', 'runtime-libraries'));
  } finally {
    restoreEnvFile();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareRivetDockerContext copies source-only wrapper build scripts outside dependency metadata', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-source-context-'));
  const sourceRoot = path.join(tempRoot, 'upstream-rivet');
  writeMinimalRivetSource(sourceRoot);

  try {
    const env: NodeJS.ProcessEnv = { RIVET_SOURCE_HOST_PATH: sourceRoot };
    const contextPath = withMutedConsoleLog(() => rivetSourceContext.prepareRivetDockerContext(tempRoot, env));
    const dependencyContextPath = env.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH;

    assert.equal(contextPath, path.join(tempRoot, '.data', 'docker-contexts', 'rivet-source'));
    assert.equal(dependencyContextPath, path.join(tempRoot, '.data', 'docker-contexts', 'rivet-dependency-metadata'));
    assert.equal(fs.existsSync(path.join(contextPath, 'scripts', 'build-wrapper-target.mjs')), true);
    assert.equal(fs.existsSync(path.join(contextPath, 'scripts', 'ci-timing.mjs')), true);
    assert.equal(fs.existsSync(path.join(dependencyContextPath, 'scripts')), false);
    assert.equal(fs.existsSync(path.join(dependencyContextPath, 'scripts', 'build-wrapper-target.mjs')), false);
    assert.equal(fs.existsSync(path.join(dependencyContextPath, 'scripts', 'ci-timing.mjs')), false);
    assert.equal(fs.existsSync(path.join(dependencyContextPath, 'packages', 'trivet', 'package.json')), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareRivetDockerContext rejects upstream checkouts without wrapper build scripts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-source-context-stale-'));
  const sourceRoot = path.join(tempRoot, 'upstream-rivet');
  writeMinimalRivetSource(sourceRoot, {
    includeBuildWrapperTarget: false,
    scripts: {
      'build:runtime': 'node scripts/build-wrapper-target.mjs runtime',
    },
  });

  try {
    assert.throws(
      () =>
        withMutedConsoleLog(() =>
          rivetSourceContext.prepareRivetDockerContext(tempRoot, { RIVET_SOURCE_HOST_PATH: sourceRoot }),
        ),
      /Expected upstream Rivet source file or directory at .*scripts.*build-wrapper-target\.mjs/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareRivetDockerContext rejects upstream package.json without required wrapper build scripts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-source-context-script-'));
  const sourceRoot = path.join(tempRoot, 'upstream-rivet');
  writeMinimalRivetSource(sourceRoot, {
    scripts: {
      'build:runtime': 'node scripts/build-wrapper-target.mjs runtime',
    },
  });

  try {
    assert.throws(
      () =>
        withMutedConsoleLog(() =>
          rivetSourceContext.prepareRivetDockerContext(tempRoot, { RIVET_SOURCE_HOST_PATH: sourceRoot }),
        ),
      /Expected upstream Rivet package\.json script "build:hosted-web-deps"/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Docker launcher env does not leak host NODE_OPTIONS unless explicitly configured', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-dev-env-node-options-'));
  const envPath = path.join(tempRoot, 'compat.env');
  fs.writeFileSync(envPath, 'RIVET_STORAGE_MODE=filesystem\n');

  const restoreEnvFile = setProcessEnvForTest('RIVET_ENV_FILE', envPath);
  const restoreNodeOptions = setProcessEnvForTest(
    'NODE_OPTIONS',
    '--require F:\\Programming\\Self-hosted-rivet\\.pnp.cjs',
  );

  try {
    const loaded = devEnv.loadDevEnv(tempRoot);
    assert.equal(loaded.mergedEnv.NODE_OPTIONS, '--require F:\\Programming\\Self-hosted-rivet\\.pnp.cjs');
    launcherEnv.dropAmbientNodeOptionsForDocker(loaded.mergedEnv, loaded.fileEnv);
    assert.equal(loaded.mergedEnv.NODE_OPTIONS, undefined);
  } finally {
    restoreEnvFile();
    restoreNodeOptions();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Docker launcher env preserves explicit NODE_OPTIONS from the env file', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-dev-env-explicit-node-options-'));
  const envPath = path.join(tempRoot, 'compat.env');
  fs.writeFileSync(envPath, [
    'RIVET_STORAGE_MODE=filesystem',
    'NODE_OPTIONS=--trace-warnings',
  ].join('\n'));

  const restoreEnvFile = setProcessEnvForTest('RIVET_ENV_FILE', envPath);
  const restoreNodeOptions = setProcessEnvForTest(
    'NODE_OPTIONS',
    '--require F:\\Programming\\Self-hosted-rivet\\.pnp.cjs',
  );

  try {
    const loaded = devEnv.loadDevEnv(tempRoot);
    launcherEnv.dropAmbientNodeOptionsForDocker(loaded.mergedEnv, loaded.fileEnv);
    assert.equal(loaded.mergedEnv.NODE_OPTIONS, '--trace-warnings');
  } finally {
    restoreEnvFile();
    restoreNodeOptions();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
