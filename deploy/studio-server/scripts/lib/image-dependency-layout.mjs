import assert from 'node:assert/strict';

// This is the repository's deliberate shell-form Dockerfile contract, not a
// general Dockerfile parser. Ignore comments and normalize continuations/CRLF.
export function assertImageDependencyLayout(source, workspaceManifests, label) {
  const instructions = source
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line && !line.startsWith('#'));
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
