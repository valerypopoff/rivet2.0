import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTestShardOptions as parseAppTestOptions,
  selectTestShard as selectAppTestShard,
} from './test-shard-options.mjs';

export { parseAppTestOptions, selectAppTestShard };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..');
const appRoot = path.join(rootDir, 'packages', 'app');
const yarnPath = path.join(rootDir, '.yarn', 'releases', 'yarn-4.17.1.cjs');

export function listAppTestFiles(testsDirectory, relativeDirectory = 'src') {
  return fs
    .readdirSync(testsDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        return listAppTestFiles(path.join(testsDirectory, entry.name), relativePath);
      }
      return entry.isFile() && /\.(?:test|spec)\.(?:[cm]?ts|tsx)$/.test(entry.name) ? [relativePath] : [];
    })
    .sort();
}

export function listDiscoveredAppTests() {
  return listAppTestFiles(path.join(appRoot, 'src'));
}

function run(commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [yarnPath, ...commandArgs], {
      cwd: rootDir,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`App test runner exited with code ${code ?? 'unknown'}.`));
      }
    });
  });
}

export function createAppTestCommands(files, shardIndex = 0, shardCount = 1) {
  const selectedFiles = selectAppTestShard(files, shardIndex, shardCount);
  if (selectedFiles.length === 0) {
    throw new Error(`App test shard ${shardIndex + 1}/${shardCount} is empty.`);
  }

  const workspace = ['workspace', '@valerypopoff/rivet-app', 'run'];
  // Use the same explicit discovery for local and CI runs. Node's implicit
  // discovery varies by runtime and omits supported TSX/spec suffixes. Bound
  // every invocation, including shards, to avoid Windows command-line limits.
  const commands = [];
  for (let index = 0; index < selectedFiles.length; index += 32) {
    commands.push([...workspace, 'test:files', '--', ...selectedFiles.slice(index, index + 32)]);
  }
  return commands;
}

export function appTestPrerequisite(dependencies = 'build') {
  if (dependencies === 'prebuilt') return ['check:compiled-workspace-exports'];
  if (dependencies === 'build') return ['workspace', '@valerypopoff/rivet2-core', 'run', 'build:esm'];
  throw new Error('RIVET_APP_TEST_DEPENDENCIES must be build or prebuilt.');
}

export async function runAppTests(
  { shardIndex = 0, shardCount = 1, dependencies = process.env.RIVET_APP_TEST_DEPENDENCIES ?? 'build' } = {},
  execute = run,
) {
  const prerequisite = appTestPrerequisite(dependencies);
  const files = listDiscoveredAppTests();
  const commands = createAppTestCommands(files, shardIndex, shardCount);

  // App tests import Core through its published ESM export. Build that
  // prerequisite here so local full and sharded App-test runs are self-contained;
  // CI opts into its same-commit artifact, but must still fail before running
  // tests if that artifact is incomplete or unloadable. Local runs build Core.
  await execute(prerequisite);

  if (shardCount !== 1) {
    const selectedCount = commands.reduce((count, command) => count + command.length - 5, 0);
    console.log(`[app-tests] Running shard ${shardIndex + 1}/${shardCount}: ${selectedCount} files.`);
  }
  for (const command of commands) {
    await execute(command);
  }
}

async function main() {
  const { shardIndex, shardCount, check } = parseAppTestOptions(process.argv.slice(2));
  const dependencies = process.env.RIVET_APP_TEST_DEPENDENCIES ?? 'build';
  appTestPrerequisite(dependencies);
  if (check) {
    const files = listDiscoveredAppTests();
    createAppTestCommands(files, shardIndex, shardCount);
    console.log(`[app-tests] Discovered ${files.length} tests; shard ${shardIndex + 1}/${shardCount} is valid.`);
    return;
  }
  await runAppTests({ shardIndex, shardCount, dependencies });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
