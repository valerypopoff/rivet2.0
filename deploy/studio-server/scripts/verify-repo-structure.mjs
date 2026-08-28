import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..', '..');

function resolveRepoPath(relativePath) {
  return path.join(rootDir, ...relativePath.split('/'));
}

function readText(relativePath) {
  return fs.readFileSync(resolveRepoPath(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

const requiredPaths = [
  'AGENTS.md',
  'package.json',
  'yarn.lock',
  '.yarnrc.yml',
  '.github/workflows/studio-server-images.yml',
  '.github/workflows/studio-server-verify.yml',
  'deploy/studio-server/.env.example',
  'deploy/studio-server/README.md',
  'deploy/studio-server/helm/Chart.yaml',
  'deploy/studio-server/compose/docker-compose.yml',
  'deploy/studio-server/compose/docker-compose.dev.yml',
  'deploy/studio-server/images/api/Dockerfile',
  'deploy/studio-server/images/web/Dockerfile',
  'deploy/studio-server/images/executor/Dockerfile',
  'deploy/studio-server/images/proxy/Dockerfile',
  'deploy/studio-server/scripts/dev-docker.mjs',
  'deploy/studio-server/scripts/dev-kubernetes.mjs',
  'developer-docs/studio-server/architecture.md',
  'developer-docs/studio-server/development.md',
  'developer-docs/studio-server/repo-structure.md',
  'developer-docs/studio-server/audits/kubernetes-managed-mode.md',
  'packages/studio-server-api/package.json',
  'packages/studio-server-web/package.json',
  'packages/studio-server-executor/package.json',
  'packages/studio-server-shared/package.json',
  'packages/studio-server-bootstrap/package.json',
];

for (const relativePath of requiredPaths) {
  assert.equal(fs.existsSync(resolveRepoPath(relativePath)), true, `Missing required monorepo path: ${relativePath}`);
}

const forbiddenPaths = [
  '_import/studio-server',
  'wrapper',
  'rivet',
  'packages/studio-server-api/package-lock.json',
  'packages/studio-server-web/package-lock.json',
  'packages/studio-server-bootstrap/package-lock.json',
  'deploy/studio-server/scripts/bootstrap-rivet.mjs',
  'deploy/studio-server/scripts/ensure-dev-deps.mjs',
  'deploy/studio-server/scripts/ensure-rivet-runtime-build.mjs',
  'deploy/studio-server/scripts/link-rivet-node-package.mjs',
  'deploy/studio-server/scripts/prepare-rivet-docker-context.mjs',
  'deploy/studio-server/scripts/run-preserve-symlinks.mjs',
  'deploy/studio-server/scripts/run-rivet-yarn.mjs',
  'deploy/studio-server/scripts/lib/rivet-source-context.mjs',
];

for (const relativePath of forbiddenPaths) {
  assert.equal(fs.existsSync(resolveRepoPath(relativePath)), false, `Obsolete split-repository path remains: ${relativePath}`);
}

const trackedFiles = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);

for (const trackedPath of trackedFiles) {
  assert.doesNotMatch(trackedPath, /^_import\/studio-server(?:\/|$)/, `Imported staging path is still tracked: ${trackedPath}`);
  assert.doesNotMatch(trackedPath, /^wrapper(?:\/|$)/, `Legacy wrapper path is still tracked: ${trackedPath}`);
  assert.doesNotMatch(trackedPath, /\.rivet-package-links(?:\/|$)/, `Legacy package-link artifact is tracked: ${trackedPath}`);
  if (trackedPath.startsWith('packages/studio-server-')) {
    assert.doesNotMatch(trackedPath, /package-lock\.json$/, `Nested npm lockfile is tracked: ${trackedPath}`);
  }
}

const rootPackage = readJson('package.json');
assert.equal(rootPackage.packageManager, 'yarn@4.17.1');
assert.deepEqual(rootPackage.workspaces, ['packages/*']);

const expectedPackageNames = new Map([
  ['packages/studio-server-api/package.json', '@valerypopoff/rivet-studio-server-api'],
  ['packages/studio-server-web/package.json', '@valerypopoff/rivet-studio-server-web'],
  ['packages/studio-server-executor/package.json', '@valerypopoff/rivet-studio-server-executor'],
  ['packages/studio-server-shared/package.json', '@valerypopoff/rivet-studio-server-shared'],
  ['packages/studio-server-bootstrap/package.json', '@valerypopoff/rivet-studio-server-bootstrap'],
]);

for (const [manifestPath, expectedName] of expectedPackageNames) {
  const manifest = readJson(manifestPath);
  assert.equal(manifest.name, expectedName, `${manifestPath} has the wrong workspace name.`);
  assert.equal(manifest.private, true, `${manifestPath} must remain private.`);
  for (const dependencyVersion of Object.values(manifest.dependencies ?? {})) {
    if (String(dependencyVersion).startsWith('file:')) {
      assert.fail(`${manifestPath} still contains a file dependency: ${dependencyVersion}`);
    }
  }
}

for (const scriptName of [
  'studio-server:build',
  'studio-server:test',
  'studio-server:dev',
  'studio-server:prod',
  'studio-server:verify:repo-structure',
  'studio-server:verify:kubernetes',
  'studio-server:ui:observe',
]) {
  assert.equal(typeof rootPackage.scripts?.[scriptName], 'string', `Missing root command: ${scriptName}`);
}

const dockerfiles = [
  'deploy/studio-server/images/api/Dockerfile',
  'deploy/studio-server/images/web/Dockerfile',
  'deploy/studio-server/images/executor/Dockerfile',
];
for (const dockerfilePath of dockerfiles) {
  const dockerfile = readText(dockerfilePath);
  assert.match(dockerfile, /COPY \. \./, `${dockerfilePath} must build from the monorepo root.`);
  assert.match(dockerfile, /yarn install --immutable/, `${dockerfilePath} must use the root Yarn lockfile.`);
  assert.doesNotMatch(dockerfile, /rivet_source|rivet_dependency_metadata|\.rivet-package-links|wrapper\//);
}

const gitignore = readText('.gitignore');
for (const pattern of ['/.data/', '/artifacts/playwright/', '.tools/']) {
  assert.ok(gitignore.includes(pattern), `.gitignore must include ${pattern}`);
}

console.log('Studio Server monorepo structure verification passed.');
