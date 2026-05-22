import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const launcherName = 'verify:repo-structure';

const requiredRootMarkdown = new Set([
  'AGENTS.md',
  'README.md',
]);

const requiredWorkingDocs = new Set([
  'backlog.md',
  'repo-rearrangement.md',
  'tests-refactor.md',
]);

const allowedRootMarkdown = new Set([
  ...requiredRootMarkdown,
  ...requiredWorkingDocs,
]);

const requiredPaths = [
  '.github',
  'AGENTS.md',
  'README.md',
  'charts',
  'docs',
  'docs/repo-structure.md',
  'image',
  'image/proxy/Dockerfile',
  'ops',
  'ops/compose',
  'ops/docker',
  'ops/nginx',
  'package.json',
  'scripts',
  'scripts/ensure-k8s-tools.mjs',
  'scripts/lib/k8s-tools.mjs',
  'scripts/update-check.sh',
  'wrapper',
  'wrapper/bootstrap/proxy-bootstrap',
  'wrapper/bootstrap/proxy-bootstrap/bootstrap.mjs',
  'wrapper/bootstrap/proxy-bootstrap/config.mjs',
  'wrapper/bootstrap/proxy-bootstrap/package-lock.json',
  'wrapper/bootstrap/proxy-bootstrap/package.json',
  'wrapper/bootstrap/proxy-bootstrap/runtime-libraries-sync.mjs',
  'wrapper/bootstrap/proxy-bootstrap/state.mjs',
  'wrapper/bootstrap/proxy-bootstrap/sync.mjs',
  'wrapper/executor/build/bundle-executor.cjs',
  'image/proxy/normalize-workflow-paths.sh',
  'image/proxy/ui-gate-prompt.html',
];

const expectedOpsEntries = {
  compose: [
    'docker-compose.dev.yml',
    'docker-compose.managed-services.yml',
    'docker-compose.yml',
  ],
  docker: [
    'Dockerfile.api',
    'Dockerfile.executor',
    'Dockerfile.web',
  ],
  nginx: [
    'default.conf.template',
    'default.dev.conf.template',
  ],
};

const forbiddenExistingPaths = [
  'ops/update-check.sh',
  'ops/ui-gate-prompt.html',
  'ops/proxy-bootstrap',
  'ops/bundle-executor.cjs',
  'ops/docker-compose.yml',
  'ops/docker-compose.dev.yml',
  'ops/docker-compose.managed-services.yml',
  'ops/Dockerfile.api',
  'ops/Dockerfile.executor',
  'ops/Dockerfile.web',
  'ops/nginx.conf',
  'ops/nginx.dev.conf',
];

function fail(message) {
  throw new Error(`[${launcherName}] ${message}`);
}

function readGitFileList(args) {
  try {
    return execFileSync('git', ['ls-files', ...args], {
      cwd: rootDir,
      encoding: 'utf8',
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`[${launcherName}] Could not read git file list (${args.join(' ')}): ${error.message}`);
  }
}

function assertPathExists(relativePath) {
  if (!fs.existsSync(path.join(rootDir, relativePath))) {
    fail(`Required path is missing: ${relativePath}`);
  }
}

function assertDirectoryEntries(relativeDirPath, expectedEntries) {
  const actualEntries = fs.readdirSync(path.join(rootDir, relativeDirPath))
    .filter((entry) => !entry.startsWith('.'))
    .sort();
  const expectedSortedEntries = [...expectedEntries].sort();
  assert.deepEqual(
    actualEntries,
    expectedSortedEntries,
    `${relativeDirPath} should contain exactly: ${expectedSortedEntries.join(', ')}`,
  );
}

function main() {
  const trackedFiles = readGitFileList([]);
  const untrackedFiles = readGitFileList(['--others', '--exclude-standard']);
  const deletedTrackedFiles = new Set(readGitFileList(['--deleted']));

  const trackedToolArtifacts = trackedFiles.filter(
    (filePath) => filePath.startsWith('.tools/') && !deletedTrackedFiles.has(filePath),
  );
  assert.equal(
    trackedToolArtifacts.length,
    0,
    `Tracked legacy tool artifacts must be removed from Git: ${trackedToolArtifacts.join(', ')}`,
  );

  const rootMarkdownFiles = [...new Set([...trackedFiles, ...untrackedFiles])].filter(
    (filePath) => !deletedTrackedFiles.has(filePath) && !filePath.includes('/') && filePath.endsWith('.md'),
  );
  const missingRequiredRootMarkdown = [...allowedRootMarkdown].filter((filePath) => !rootMarkdownFiles.includes(filePath));
  assert.equal(
    missingRequiredRootMarkdown.length,
    0,
    `Expected root Markdown files are missing: ${missingRequiredRootMarkdown.join(', ')}`,
  );
  const unexpectedRootMarkdown = rootMarkdownFiles.filter((filePath) => !allowedRootMarkdown.has(filePath));
  assert.equal(
    unexpectedRootMarkdown.length,
    0,
    `Unexpected root Markdown files found: ${unexpectedRootMarkdown.join(', ')}`,
  );

  const trackedMovedLocalState = trackedFiles.filter(
    (filePath) => !deletedTrackedFiles.has(filePath) && filePath.startsWith('wrapper/bootstrap/proxy-bootstrap/node_modules/'),
  );
  assert.equal(
    trackedMovedLocalState.length,
    0,
    `Moved bootstrap package local state must not be tracked: ${trackedMovedLocalState.join(', ')}`,
  );

  for (const requiredPath of requiredPaths) {
    assertPathExists(requiredPath);
  }

  const unexpectedOpsEntries = fs.readdirSync(path.join(rootDir, 'ops'), { withFileTypes: true })
    .filter((entry) => !['compose', 'docker', 'nginx'].includes(entry.name))
    .map((entry) => entry.name);
  assert.equal(
    unexpectedOpsEntries.length,
    0,
    `ops/ should only contain compose, docker, and nginx after the rearrangement. Found: ${unexpectedOpsEntries.join(', ')}`,
  );
  for (const [opsSubdir, expectedEntries] of Object.entries(expectedOpsEntries)) {
    assertDirectoryEntries(path.join('ops', opsSubdir), expectedEntries);
  }

  for (const forbiddenPath of forbiddenExistingPaths) {
    assert.equal(
      fs.existsSync(path.join(rootDir, forbiddenPath)),
      false,
      `Legacy path should not exist anymore: ${forbiddenPath}`,
    );
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.equal(
    Object.hasOwn(packageJson, 'packageManager'),
    false,
    'Root package.json should not declare a packageManager after standardizing on npm launcher commands.',
  );
  const requiredScripts = [
    'setup',
    'setup:k8s-tools',
    'setup:rivet',
    'verify:repo-structure',
    'verify:test-style',
    'verify:kubernetes',
    'dev:docker:config',
    'prod',
    'prod:prebuilt',
    'prod:restart',
    'prod:custom',
    'dev:kubernetes-test:config',
  ];
  const missingScripts = requiredScripts.filter((scriptName) => !packageJson.scripts?.[scriptName]);
  assert.equal(
    missingScripts.length,
    0,
    `Root package.json is missing required repo/tooling scripts: ${missingScripts.join(', ')}`,
  );

  const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
  for (const requiredPattern of ['.tools/', 'wrapper/**/node_modules/']) {
    assert.equal(
      gitignore.includes(requiredPattern),
      true,
      `.gitignore should contain the repo-structure guardrail pattern: ${requiredPattern}`,
    );
  }

  const dockerignore = fs.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');
  for (const requiredPattern of ['**/node_modules', '!wrapper/executor/build/', '!wrapper/executor/build/bundle-executor.cjs']) {
    assert.equal(
      dockerignore.includes(requiredPattern),
      true,
      `.dockerignore should contain the repo/build guardrail pattern: ${requiredPattern}`,
    );
  }

  const gitattributes = fs.readFileSync(path.join(rootDir, '.gitattributes'), 'utf8');
  assert.match(gitattributes, /^\*\.sh text eol=lf$/m, 'Shell scripts should stay LF-normalized for Linux containers.');

  const proxyBootstrapBytes = fs.readFileSync(path.join(rootDir, 'image/proxy/normalize-workflow-paths.sh'));
  assert.equal(
    proxyBootstrapBytes.includes(Buffer.from('\r\n')),
    false,
    'image/proxy/normalize-workflow-paths.sh should not contain CRLF line endings.',
  );
  assert.match(
    proxyBootstrapBytes.toString('utf8'),
    /^#!\/bin\/sh\n/,
    'image/proxy/normalize-workflow-paths.sh should keep its POSIX shell shebang.',
  );

  console.log(`[${launcherName}] Repo structure checks passed.`);
}

try {
  main();
} catch (error) {
  if (error instanceof Error && error.message.startsWith(`[${launcherName}]`)) {
    throw error;
  }
  fail(error.message);
}
