import assert from 'node:assert/strict';

// This is the repository's deliberate shell-form Dockerfile contract, not a
// general Dockerfile parser. Ignore comments and normalize continuations/CRLF.
function dockerInstructions(source) {
  return source
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line && !line.startsWith('#'));
}

export function assertImageDependencyLayout(source, workspaceManifests, label) {
  const instructions = dockerInstructions(source);
  const install = instructions.findIndex(
    (line) => line.startsWith('RUN ') && /\byarn install --immutable(?: |$)/.test(line),
  );
  assert.ok(install >= 0, `${label} must use the root Yarn lockfile.`);
  assert.ok(
    instructions
      .slice(0, install)
      .filter((line) => line.startsWith('WORKDIR '))
      .at(-1) === 'WORKDIR /app',
    `${label} must install in the monorepo work directory.`,
  );
  for (const input of [
    'COPY package.json yarn.lock .yarnrc.yml ./',
    'COPY .yarn ./.yarn',
    'COPY scripts/checks/check-package-manager.mjs ./scripts/checks/check-package-manager.mjs',
    ...workspaceManifests.map((manifest) => `COPY ${manifest} ./${manifest}`),
  ]) {
    const index = instructions.indexOf(input);
    assert.ok(index >= 0 && index < install, `${label} must include ${input} before install.`);
  }
  for (const directory of ['packages', 'scripts', 'deploy']) {
    assert.ok(
      instructions.indexOf(`COPY ${directory} ./${directory}`) > install,
      `${label} must copy ${directory} sources after install.`,
    );
  }
  assert.ok(
    !instructions.some((line) => /^COPY \.\/? \.\/?$/.test(line)),
    `${label} must not recopy the dependency cache after installing.`,
  );
}

export function assertRuntimeDependencyCopyLayout(source, label) {
  const lines = dockerInstructions(source);
  const copy = lines.indexOf('FROM dependencies AS runtime-dependency-copy');
  const runtime = lines.indexOf('FROM scratch AS runtime-dependencies');
  const shared = lines.indexOf('FROM dependencies AS runtime-build');
  const builder = lines.indexOf('FROM runtime-build AS builder');
  assert.ok(
    copy >= 0 && runtime > copy && shared > runtime && builder > shared,
    `${label} must isolate runtime pruning from the builder.`,
  );
  const pruning = lines.flatMap((line, index) =>
    line.startsWith('RUN ') && line.includes('node /tmp/remove-runtime-build-globs.mjs') ? [index] : [],
  );
  assert.ok(
    pruning.length === 1 && pruning[0] > copy && pruning[0] < runtime,
    `${label} must prune only the runtime dependency copy.`,
  );
  assert.ok(
    lines[pruning[0]].endsWith('node /tmp/remove-runtime-build-globs.mjs /runtime-dependencies/app/node_modules'),
    `${label} must preserve builder node_modules.`,
  );
  assert.ok(
    lines
      .slice(runtime, shared)
      .includes('COPY --link --from=runtime-dependency-copy --chown=10001:10001 /runtime-dependencies/ /'),
    `${label} must ship the pruned runtime copy.`,
  );
}
