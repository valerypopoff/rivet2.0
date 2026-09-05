import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { defaultApiTestFiles, kubernetesApiTestFiles } from './api-test-files.mjs';

const rootDir = process.cwd();
const launcherName = 'verify:test-style';

const retiredTestNames = [
  'managed-backend-sql.test.ts',
  'phase4-static-contract.test.ts',
  'workflow-publication.test.ts',
  'workflow-services.test.ts',
];

const allowedRivetAppSourceRefs = new Set(['packages/app/src/host.css']);

function fail(message) {
  throw new Error(`[${launcherName}] ${message}`);
}

function readFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readFile(relativePath));
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function listTopLevelFiles(relativeDir, predicate) {
  const absoluteDir = path.join(rootDir, relativeDir);
  return fs
    .readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => `${relativeDir}/${entry.name}`)
    .map((filePath) => filePath.replaceAll('\\', '/'))
    .sort();
}

function normalizeSourceForPathScan(source) {
  return source.replace(/\\([/.[\]{}()*+?^$|])/g, '$1').replace(/\\\\/g, '/');
}

function normalizeRivetPackageRef(ref) {
  return ref.replace(/\/+$/, '');
}

function listFilesRecursive(relativeDir, predicate) {
  const results = [];
  const absoluteRoot = path.join(rootDir, relativeDir);

  function visit(absoluteDir) {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolutePath = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && predicate(entry.name)) {
        results.push(toPosixPath(path.relative(rootDir, absolutePath)));
      }
    }
  }

  visit(absoluteRoot);
  return results.sort();
}

function assertOnlyTopLevelTestFiles(relativeDir, testFiles, label) {
  const recursiveTestFiles = listFilesRecursive(relativeDir, (name) => name.endsWith('.test.ts'));

  assert.deepEqual(
    recursiveTestFiles,
    testFiles,
    `${label} should keep runnable .test.ts files at the top level so package scripts can list them explicitly.`,
  );
}

function assertOnlyTopLevelSpecFiles(relativeDir, specFiles, label) {
  const recursiveSpecFiles = listFilesRecursive(relativeDir, (name) => name.endsWith('.spec.ts'));

  assert.deepEqual(
    recursiveSpecFiles,
    specFiles,
    `${label} should keep runnable .spec.ts files at the top level so helper folders cannot become hidden Playwright suites.`,
  );
}

function extractTestPaths(command) {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter((token) => token.endsWith('.test.ts'))
    .map((token) => token.replaceAll('\\', '/'));
}

function assertNoDuplicates(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  assert.equal(
    duplicates.length,
    0,
    `${label} should not contain duplicate entries: ${[...new Set(duplicates)].join(', ')}`,
  );
}

function sortValues(values) {
  return [...values].sort();
}

function assertCommandHasExplicitTestFiles(command, label) {
  assert.doesNotMatch(command, /\*.test\.ts/, `${label} should list test files explicitly instead of using a glob.`);
  assert.doesNotMatch(command, /\bnpx\s+tsx\b/, `${label} should use the repo-local tsx toolchain instead of npx.`);
}

function assertRootTestCommand(command) {
  const requiredSegments = [
    'yarn studio-server:build',
    'yarn studio-server:verify:clean',
    'yarn studio-server:verify:dev-watcher',
    'yarn workspace @valerypopoff/rivet-studio-server-api run test',
    'yarn studio-server:verify:web-pure',
    'yarn studio-server:verify:test-style',
    'yarn studio-server:verify:repo-structure',
    'yarn studio-server:verify:kubernetes',
  ];

  for (const segment of requiredSegments) {
    assert.equal(command.includes(segment), true, `Root test command should run ${segment}.`);
  }

  assert.doesNotMatch(
    command,
    /(?:ui:observe|playwright-observe)/,
    'Root test command should not launch Playwright; browser runs need an explicit app target.',
  );
}

function assertApiFocusedTestCommand(command) {
  assert.match(
    command,
    /\btsx --test\b/,
    'packages/studio-server-api test:files should use the same Node test runner path as the default API suite.',
  );
  assert.match(
    command,
    /--test-concurrency=1\b/,
    'packages/studio-server-api test:files should keep focused API files serialized like the default API suite.',
  );
  assert.doesNotMatch(
    command,
    /\.test\.ts\b/,
    'packages/studio-server-api test:files should not list files; callers pass the focused files after `--`.',
  );
}

function assertNoRetiredTestFiles() {
  const candidateDirs = [
    'packages/studio-server-api/src/tests',
    'packages/studio-server-web/tests',
    'packages/studio-server-web/playwright-observe',
  ];

  for (const relativeDir of candidateDirs) {
    for (const retiredName of retiredTestNames) {
      assert.equal(
        fs.existsSync(path.join(rootDir, relativeDir, retiredName)),
        false,
        `${relativeDir}/${retiredName} should not be reintroduced.`,
      );
    }
  }
}

function assertNodeTestFileStyle(testFiles) {
  for (const testFile of testFiles) {
    const contents = readFile(testFile);
    assert.match(contents, /from ['"]node:test['"]/, `${testFile} should use Node's built-in test runner.`);
  }
}

function assertPlaywrightFileStyle(testFiles) {
  for (const testFile of testFiles) {
    const contents = readFile(testFile);
    assert.match(contents, /from ['"]@playwright\/test['"]/, `${testFile} should use the Playwright test runner.`);
  }
}

function assertPlaywrightSpecsDoNotReadLocalPackageMetadata(testFiles) {
  for (const testFile of testFiles) {
    const contents = readFile(testFile);
    assert.doesNotMatch(
      contents,
      /(?:readFileSync|new URL|from\s+['"])[^;\n]*package\.json/,
      `${testFile} should not read local package.json metadata; observable Playwright specs validate the live app target, which may be a previously built container.`,
    );
  }
}

function assertNoFocusedTests(testFiles) {
  for (const testFile of testFiles) {
    const contents = readFile(testFile);
    assert.doesNotMatch(
      contents,
      /\b(?:test|it|describe)\.only\s*\(/,
      `${testFile} should not contain focused .only tests.`,
    );
  }
}

function assertNoUpstreamAppSourceContracts(testFiles) {
  for (const testFile of testFiles) {
    const contents = readFile(testFile);
    const normalizedContents = normalizeSourceForPathScan(contents);

    for (const match of normalizedContents.matchAll(/packages\/app\/src[A-Za-z0-9._/-]*/g)) {
      const rivetPackageRef = normalizeRivetPackageRef(match[0]);
      assert.equal(
        allowedRivetAppSourceRefs.has(rivetPackageRef),
        true,
        `${testFile} reads ${rivetPackageRef}; wrapper tests should only assert approved upstream app host seams.`,
      );
    }
  }
}

function main() {
  const rootPackage = readJson('package.json');
  const apiPackage = readJson('packages/studio-server-api/package.json');
  const webPackage = readJson('packages/studio-server-web/package.json');

  const rootScripts = rootPackage.scripts ?? {};
  const apiScripts = apiPackage.scripts ?? {};
  const webScripts = webPackage.scripts ?? {};

  assert.equal(
    typeof rootScripts['studio-server:test'],
    'string',
    'Root package.json should expose studio-server:test.',
  );
  assert.equal(
    typeof rootScripts['studio-server:verify:test-style'],
    'string',
    'Root package.json should expose studio-server:verify:test-style.',
  );
  assert.equal(
    typeof rootScripts['studio-server:verify:clean'],
    'string',
    'Root package.json should expose studio-server:verify:clean.',
  );
  assert.equal(
    typeof apiScripts.test,
    'string',
    'packages/studio-server-api package.json should expose the default API test command.',
  );
  assert.equal(
    typeof apiScripts['test:files'],
    'string',
    'packages/studio-server-api package.json should expose test:files for focused API test runs.',
  );
  assert.equal(typeof webScripts.test, 'string', 'packages/studio-server-web package.json should expose test.');
  assert.equal(
    typeof rootScripts['studio-server:verify:web-pure'],
    'string',
    'Root package.json should expose studio-server:verify:web-pure.',
  );
  assert.equal(
    typeof rootScripts['studio-server:verify:kubernetes'],
    'string',
    'Root package.json should expose studio-server:verify:kubernetes.',
  );

  const apiTestFiles = listTopLevelFiles('packages/studio-server-api/src/tests', (name) => name.endsWith('.test.ts'));
  const apiTestFilesFromApiPackageRoot = apiTestFiles.map((filePath) =>
    filePath.replace(/^packages\/studio-server-api\//, ''),
  );
  const detectedKubernetesApiTests = apiTestFilesFromApiPackageRoot.filter((filePath) =>
    filePath.startsWith('src/tests/kubernetes-'),
  );
  const detectedDefaultApiTestFiles = apiTestFilesFromApiPackageRoot.filter(
    (filePath) => !kubernetesApiTestFiles.includes(filePath),
  );
  const webPureTestFiles = listTopLevelFiles('packages/studio-server-web/tests', (name) => name.endsWith('.test.ts'));
  const webPureTestFilesFromWebPackageRoot = webPureTestFiles.map((filePath) =>
    filePath.replace(/^packages\/studio-server-web\//, ''),
  );
  const playwrightSpecFiles = listTopLevelFiles('packages/studio-server-web/playwright-observe', (name) =>
    name.endsWith('.spec.ts'),
  );

  assertOnlyTopLevelTestFiles('packages/studio-server-api/src/tests', apiTestFiles, 'API tests');
  assertOnlyTopLevelTestFiles('packages/studio-server-web/tests', webPureTestFiles, 'pure web tests');
  assertOnlyTopLevelSpecFiles('packages/studio-server-web/playwright-observe', playwrightSpecFiles, 'Playwright specs');

  assert.equal(
    apiScripts.test,
    'node ../../deploy/studio-server/scripts/run-api-tests.mjs',
    'packages/studio-server-api test should use the canonical manifest-driven runner.',
  );
  assertCommandHasExplicitTestFiles(webScripts.test, 'packages/studio-server-web test');
  assertCommandHasExplicitTestFiles(rootScripts['studio-server:verify:kubernetes'], 'studio-server:verify:kubernetes');
  assertRootTestCommand(rootScripts['studio-server:test']);
  assert.equal(apiScripts.pretest, undefined, 'The API workspace must not bootstrap a second repository in pretest.');
  assert.equal(
    apiScripts['pretest:files'],
    undefined,
    'Focused API tests must use the installed root workspace directly.',
  );
  assertApiFocusedTestCommand(apiScripts['test:files']);

  const apiCommandFiles = defaultApiTestFiles;
  const webCommandFiles = extractTestPaths(webScripts.test);
  const kubernetesCommandFiles = extractTestPaths(rootScripts['studio-server:verify:kubernetes']);

  assertNoDuplicates(apiCommandFiles, 'packages/studio-server-api test');
  assertNoDuplicates(webCommandFiles, 'packages/studio-server-web test');
  assertNoDuplicates(kubernetesCommandFiles, 'studio-server:verify:kubernetes');

  assert.deepEqual(
    sortValues(detectedKubernetesApiTests),
    sortValues(kubernetesApiTestFiles),
    'Every kubernetes-*.test.ts API file should be owned by verify:kubernetes.',
  );
  assert.deepEqual(
    apiCommandFiles,
    detectedDefaultApiTestFiles,
    'The API test manifest should list every non-Kubernetes API test exactly once, in sorted order.',
  );
  assert.deepEqual(
    webCommandFiles,
    webPureTestFilesFromWebPackageRoot,
    'packages/studio-server-web test should list every pure web test exactly once, in sorted order.',
  );
  assert.deepEqual(
    sortValues(kubernetesCommandFiles),
    sortValues(kubernetesApiTestFiles),
    'studio-server:verify:kubernetes should own the Kubernetes API test files outside the default API suite.',
  );

  assert.match(
    rootScripts['studio-server:verify:kubernetes'],
    /node deploy\/studio-server\/scripts\/verify-kubernetes\.mjs/,
    'studio-server:verify:kubernetes should still run the Helm render verifier after Kubernetes API tests.',
  );

  assertNoRetiredTestFiles();

  const nodeTestFiles = [...apiTestFiles, ...webPureTestFiles];
  const allTestFiles = [
    ...nodeTestFiles,
    ...playwrightSpecFiles,
    ...listFilesRecursive('packages/studio-server-api/src/tests/helpers', (name) => name.endsWith('.ts')),
    ...listFilesRecursive('packages/studio-server-web/playwright-observe/helpers', (name) => name.endsWith('.ts')),
  ];

  assertNodeTestFileStyle(nodeTestFiles);
  assertPlaywrightFileStyle(playwrightSpecFiles);
  assertPlaywrightSpecsDoNotReadLocalPackageMetadata(playwrightSpecFiles);
  assertNoFocusedTests(allTestFiles);
  assertNoUpstreamAppSourceContracts(allTestFiles);

  console.log(`[${launcherName}] Test style guardrails passed.`);
}

try {
  main();
} catch (error) {
  if (error instanceof Error && error.message.startsWith(`[${launcherName}]`)) {
    throw error;
  }
  fail(error instanceof Error ? error.message : String(error));
}
