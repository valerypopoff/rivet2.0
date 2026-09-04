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
  'scripts/checks/check-package-manager.mjs',
  '.github/workflows/studio-server-images.yml',
  '.github/workflows/studio-server-verify.yml',
  'deploy/studio-server/scripts/api-test-files.mjs',
  'deploy/studio-server/scripts/run-api-tests.mjs',
  'deploy/studio-server/scripts/candidate-image-smoke.mjs',
  'deploy/studio-server/.env.example',
  'deploy/studio-server/.env.kubernetes-local.example',
  'deploy/studio-server/README.md',
  'deploy/studio-server/kubernetes-test/local-dependencies.yaml',
  'deploy/studio-server/helm/Chart.yaml',
  'deploy/studio-server/compose/docker-compose.yml',
  'deploy/studio-server/compose/docker-compose.dev.yml',
  'deploy/studio-server/compose/docker/Dockerfile.web',
  'deploy/studio-server/images/api/Dockerfile',
  'deploy/studio-server/images/web/Dockerfile',
  'deploy/studio-server/images/executor/Dockerfile',
  'deploy/studio-server/images/proxy/Dockerfile',
  'deploy/studio-server/scripts/clean-docker.mjs',
  'deploy/studio-server/scripts/clean-docker.test.mjs',
  'deploy/studio-server/scripts/dev-docker.mjs',
  'deploy/studio-server/scripts/dev-kubernetes.mjs',
  'deploy/studio-server/scripts/verify-migration-ledger.mjs',
  'deploy/studio-server/migration/source-file-ledger.json',
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
  assert.equal(
    fs.existsSync(resolveRepoPath(relativePath)),
    false,
    `Obsolete split-repository path remains: ${relativePath}`,
  );
}

const repositoryFiles = [
  ...execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' }).split(/\r?\n/),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).split(/\r?\n/),
].filter(Boolean);
const trackedFiles = [...new Set(repositoryFiles)];

for (const trackedPath of trackedFiles) {
  assert.doesNotMatch(
    trackedPath,
    /^_import\/studio-server(?:\/|$)/,
    `Imported staging path is still tracked: ${trackedPath}`,
  );
  assert.doesNotMatch(trackedPath, /^wrapper(?:\/|$)/, `Legacy wrapper path is still tracked: ${trackedPath}`);
  assert.doesNotMatch(
    trackedPath,
    /\.rivet-package-links(?:\/|$)/,
    `Legacy package-link artifact is tracked: ${trackedPath}`,
  );
  if (/(?:^|\/)(?:yarn\.lock|package-lock\.json|npm-shrinkwrap\.json)$/.test(trackedPath)) {
    assert.equal(trackedPath, 'yarn.lock', `Secondary package-manager lockfile is present: ${trackedPath}`);
  }
}

const studioServerMarkdownPaths = trackedFiles.filter(
  (trackedPath) =>
    trackedPath.endsWith('.md') &&
    (trackedPath.startsWith('developer-docs/studio-server/') || trackedPath.startsWith('deploy/studio-server/')),
);

for (const markdownPath of studioServerMarkdownPaths) {
  const markdown = readText(markdownPath);
  for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1);
    }
    if (/^(?:https?:|mailto:|#|\/)/.test(target)) {
      continue;
    }

    const relativeTarget = decodeURIComponent(target.split('#', 1)[0]);
    if (!relativeTarget) {
      continue;
    }

    const resolvedTarget = path.resolve(path.dirname(resolveRepoPath(markdownPath)), relativeTarget);
    assert.equal(fs.existsSync(resolvedTarget), true, `Broken relative Markdown link in ${markdownPath}: ${target}`);
  }
}

const rootPackage = readJson('package.json');
assert.equal(rootPackage.packageManager, 'yarn@4.17.1');
assert.deepEqual(rootPackage.workspaces, ['packages/*']);
assert.equal(rootPackage.scripts?.preinstall, 'node scripts/checks/check-package-manager.mjs');
assert.equal(rootPackage.scripts?.['build:all'], 'yarn build');
assert.equal(rootPackage.scripts?.prod, undefined, 'Do not add an ambiguous root prod command.');
assert.equal(rootPackage.scripts?.['dev:server'], undefined, 'Studio Server commands must remain namespaced.');

function assertNoNpmWorkspaceDispatch(manifestPath, scripts) {
  for (const [scriptName, script] of Object.entries(scripts ?? {})) {
    assert.doesNotMatch(
      String(script),
      /\bnpm\s+(?:run|--prefix)\b/,
      `${manifestPath} script ${scriptName} dispatches monorepo work through npm. Use Yarn workspaces instead.`,
    );
  }
}

assertNoNpmWorkspaceDispatch('package.json', rootPackage.scripts);

const workspaceManifestPaths = trackedFiles.filter((trackedPath) =>
  /^packages\/[^/]+\/package\.json$/.test(trackedPath),
);
for (const manifestPath of workspaceManifestPaths) {
  assertNoNpmWorkspaceDispatch(manifestPath, readJson(manifestPath).scripts);
}

const expectedPackageNames = new Map([
  ['packages/studio-server-api/package.json', '@valerypopoff/rivet-studio-server-api'],
  ['packages/studio-server-web/package.json', '@valerypopoff/rivet-studio-server-web'],
  ['packages/studio-server-executor/package.json', '@valerypopoff/rivet-studio-server-executor'],
  ['packages/studio-server-shared/package.json', '@valerypopoff/rivet-studio-server-shared'],
  ['packages/studio-server-bootstrap/package.json', '@valerypopoff/rivet-studio-server-bootstrap'],
]);

const studioServerVersions = new Set();
for (const [manifestPath, expectedName] of expectedPackageNames) {
  const manifest = readJson(manifestPath);
  assert.equal(manifest.name, expectedName, `${manifestPath} has the wrong workspace name.`);
  assert.equal(manifest.private, true, `${manifestPath} must remain private.`);
  assert.equal(manifest.packageManager, undefined, `${manifestPath} must use the root package manager.`);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  studioServerVersions.add(manifest.version);
  for (const dependencyVersion of Object.values(manifest.dependencies ?? {})) {
    if (String(dependencyVersion).startsWith('file:')) {
      assert.fail(`${manifestPath} still contains a file dependency: ${dependencyVersion}`);
    }
  }
}
assert.equal(
  studioServerVersions.size,
  1,
  `Studio Server packages must use one product version. Found: ${[...studioServerVersions].join(', ')}`,
);

for (const scriptName of [
  'studio-server:build',
  'studio-server:test',
  'studio-server:dev',
  'studio-server:dev:docker',
  'studio-server:dev:down',
  'studio-server:dev:recreate',
  'studio-server:clean',
  'studio-server:prod',
  'studio-server:prod:prebuilt',
  'studio-server:verify:clean',
  'studio-server:verify:host-compatibility',
  'studio-server:verify:migration-ledger',
  'studio-server:verify:repo-structure',
  'studio-server:verify:kubernetes',
  'studio-server:ui:observe',
]) {
  assert.equal(typeof rootPackage.scripts?.[scriptName], 'string', `Missing root command: ${scriptName}`);
}
assert.match(
  rootPackage.scripts['studio-server:test'],
  /studio-server:verify:migration-ledger/,
  'The full Studio Server gate must verify the source-file migration ledger.',
);

for (const markdownPath of [
  'deploy/studio-server/README.md',
  'developer-docs/studio-server/architecture.md',
  'developer-docs/studio-server/development.md',
  'developer-docs/studio-server/repo-structure.md',
]) {
  assert.doesNotMatch(
    readText(markdownPath),
    /^\s*(?:[$>]\s*)?npm run prod(?::(?:prebuilt|restart|custom))?\s*$/m,
    `${markdownPath} presents a retired npm production command as executable guidance.`,
  );
}

const verifyWorkflow = readText('.github/workflows/studio-server-verify.yml');
assert.match(verifyWorkflow, /pull_request:\r?\n\s+branches:\r?\n\s+- develop/);
assert.doesNotMatch(verifyWorkflow, /codex\/import-studio-server/);
assert.match(verifyWorkflow, /Check Out Repository[\s\S]*fetch-depth: 0/);
assert.match(verifyWorkflow, /workflow_call:/);
assert.match(verifyWorkflow, /run-api-tests\.mjs --shard-index/);

const compatibilityScanner = readText('deploy/studio-server/scripts/update-check.sh');
assert.match(compatibilityScanner, /SCRIPT_DIR\/\.\.\/\.\.\/\.\./);
assert.doesNotMatch(compatibilityScanner, /replacing rivet\//i);

const imageWorkflow = readText('.github/workflows/studio-server-images.yml');
assert.match(imageWorkflow, /verify-repository:\s*\r?\n\s+uses: \.\/\.github\/workflows\/studio-server-verify\.yml/);
assert.match(imageWorkflow, /fast-container-smoke:[\s\S]*studio-server:verify:candidate-images/);
assert.match(imageWorkflow, /managed-kubernetes-release-gate:[\s\S]*full_kubernetes/);
const imageWorkflowPermissions = /^permissions:\r?\n((?:^[ \t]+[^\r\n]*\r?\n)+)/m.exec(imageWorkflow)?.[1] ?? '';
assert.match(imageWorkflowPermissions, /^\s+actions:\s+read\s*$/m);
assert.match(imageWorkflowPermissions, /^\s+contents:\s+read\s*$/m);
assert.match(imageWorkflowPermissions, /^\s+packages:\s+write\s*$/m);
assert.match(imageWorkflow, /IMAGE_NAMESPACE: ghcr\.io\/valerypopoff\/rivet2\.0-studio-server/);
assert.match(
  imageWorkflow,
  /name: managed-kubernetes-release-gate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
);
assert.match(
  imageWorkflow,
  /name: managed-kubernetes-provider-gate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
);
assert.doesNotMatch(imageWorkflow, /cloud-hosted-rivet2-wrapper/);

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

for (const webDockerfilePath of [
  'deploy/studio-server/images/web/Dockerfile',
  'deploy/studio-server/compose/docker/Dockerfile.web',
]) {
  assert.match(
    readText(webDockerfilePath),
    /npm install -g serve@14\.2\.6/,
    `${webDockerfilePath} must pin the tested static web server version.`,
  );
}

const gitignore = readText('.gitignore');
for (const pattern of ['/.data/', '/artifacts/playwright/', '.tools/']) {
  assert.ok(gitignore.includes(pattern), `.gitignore must include ${pattern}`);
}

console.log('Studio Server monorepo structure verification passed.');
