import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const launcherName = 'verify:test-style';

const kubernetesApiTests = [
  'src/tests/kubernetes-contract.test.ts',
  'src/tests/kubernetes-launcher-config.test.ts',
];

const retiredTestNames = [
  'managed-backend-sql.test.ts',
  'phase4-static-contract.test.ts',
  'workflow-publication.test.ts',
  'workflow-services.test.ts',
];

const allowedRivetAppSourceRefs = new Set([
  'rivet/packages/app/src/host.css',
]);

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
  return fs.readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => `${relativeDir}/${entry.name}`)
    .map((filePath) => filePath.replaceAll('\\', '/'))
    .sort();
}

function normalizeSourceForPathScan(source) {
  return source
    .replace(/\\([/.[\]{}()*+?^$|])/g, '$1')
    .replace(/\\\\/g, '/');
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
    'npm --prefix wrapper/api run build',
    'npm --prefix wrapper/api test',
    'npm run verify:web-pure',
    'npm run verify:test-style',
    'npm run verify:repo-structure',
    'npm run verify:kubernetes',
  ];

  for (const segment of requiredSegments) {
    assert.equal(
      command.includes(segment),
      true,
      `Root test command should run ${segment}.`,
    );
  }

  assert.doesNotMatch(
    command,
    /(?:ui:observe|playwright-observe)/,
    'Root test command should not launch Playwright; browser runs need an explicit app target.',
  );
}

function assertRootPretestCommand(command) {
  assert.equal(
    command,
    'node scripts/ensure-dev-deps.mjs',
    'Root pretest command should run the standard dependency bootstrap before the full test gate.',
  );
}

function assertNoRetiredTestFiles() {
  const candidateDirs = [
    'wrapper/api/src/tests',
    'wrapper/web/tests',
    'wrapper/web/playwright-observe',
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

    for (const match of normalizedContents.matchAll(/rivet\/packages\/app\/src[A-Za-z0-9._/-]*/g)) {
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
  const apiPackage = readJson('wrapper/api/package.json');

  const rootScripts = rootPackage.scripts ?? {};
  const apiScripts = apiPackage.scripts ?? {};

  assert.equal(typeof rootScripts.test, 'string', 'Root package.json should expose test.');
  assert.equal(typeof rootScripts.pretest, 'string', 'Root package.json should expose pretest.');
  assert.equal(typeof rootScripts['verify:test-style'], 'string', 'Root package.json should expose verify:test-style.');
  assert.equal(typeof apiScripts.test, 'string', 'wrapper/api package.json should expose the default API test command.');
  assert.equal(typeof rootScripts['verify:web-pure'], 'string', 'Root package.json should expose verify:web-pure.');
  assert.equal(typeof rootScripts['verify:kubernetes'], 'string', 'Root package.json should expose verify:kubernetes.');

  const apiTestFiles = listTopLevelFiles('wrapper/api/src/tests', (name) => name.endsWith('.test.ts'));
  const apiTestFilesFromApiPackageRoot = apiTestFiles.map((filePath) => filePath.replace(/^wrapper\/api\//, ''));
  const detectedKubernetesApiTests = apiTestFilesFromApiPackageRoot.filter(
    (filePath) => filePath.startsWith('src/tests/kubernetes-'),
  );
  const defaultApiTestFiles = apiTestFilesFromApiPackageRoot.filter(
    (filePath) => !kubernetesApiTests.includes(filePath),
  );
  const webPureTestFiles = listTopLevelFiles('wrapper/web/tests', (name) => name.endsWith('.test.ts'));
  const playwrightSpecFiles = listTopLevelFiles('wrapper/web/playwright-observe', (name) => name.endsWith('.spec.ts'));

  assertOnlyTopLevelTestFiles('wrapper/api/src/tests', apiTestFiles, 'API tests');
  assertOnlyTopLevelTestFiles('wrapper/web/tests', webPureTestFiles, 'pure web tests');
  assertOnlyTopLevelSpecFiles('wrapper/web/playwright-observe', playwrightSpecFiles, 'Playwright specs');

  assertCommandHasExplicitTestFiles(apiScripts.test, 'wrapper/api test');
  assertCommandHasExplicitTestFiles(rootScripts['verify:web-pure'], 'verify:web-pure');
  assertCommandHasExplicitTestFiles(rootScripts['verify:kubernetes'], 'verify:kubernetes');
  assertRootTestCommand(rootScripts.test);
  assertRootPretestCommand(rootScripts.pretest);

  const apiCommandFiles = extractTestPaths(apiScripts.test);
  const webCommandFiles = extractTestPaths(rootScripts['verify:web-pure']);
  const kubernetesCommandFiles = extractTestPaths(rootScripts['verify:kubernetes'])
    .map((filePath) => filePath.replace(/^wrapper\/api\//, ''));

  assertNoDuplicates(apiCommandFiles, 'wrapper/api test');
  assertNoDuplicates(webCommandFiles, 'verify:web-pure');
  assertNoDuplicates(kubernetesCommandFiles, 'verify:kubernetes');

  assert.deepEqual(
    sortValues(detectedKubernetesApiTests),
    sortValues(kubernetesApiTests),
    'Every kubernetes-*.test.ts API file should be owned by verify:kubernetes.',
  );
  assert.deepEqual(
    apiCommandFiles,
    defaultApiTestFiles,
    'wrapper/api test should list every non-Kubernetes API test exactly once, in sorted order.',
  );
  assert.deepEqual(
    webCommandFiles,
    webPureTestFiles,
    'verify:web-pure should list every pure web test exactly once, in sorted order.',
  );
  assert.deepEqual(
    sortValues(kubernetesCommandFiles),
    sortValues(kubernetesApiTests),
    'verify:kubernetes should own the Kubernetes API test files outside the default API suite.',
  );

  assert.match(
    rootScripts['verify:kubernetes'],
    /node scripts\/verify-kubernetes\.mjs/,
    'verify:kubernetes should still run the Helm render verifier after Kubernetes API tests.',
  );

  assertNoRetiredTestFiles();

  const nodeTestFiles = [
    ...apiTestFiles,
    ...webPureTestFiles,
  ];
  const allTestFiles = [
    ...nodeTestFiles,
    ...playwrightSpecFiles,
    ...listFilesRecursive('wrapper/api/src/tests/helpers', (name) => name.endsWith('.ts')),
    ...listFilesRecursive('wrapper/web/playwright-observe/helpers', (name) => name.endsWith('.ts')),
  ];

  assertNodeTestFileStyle(nodeTestFiles);
  assertPlaywrightFileStyle(playwrightSpecFiles);
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
