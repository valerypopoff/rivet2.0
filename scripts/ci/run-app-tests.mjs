import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..');
const appRoot = path.join(rootDir, 'packages', 'app');
const yarnPath = path.join(rootDir, '.yarn', 'releases', 'yarn-4.17.1.cjs');

function parseIntegerFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }

  const value = Number(args[index + 1]);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

export function selectAppTestShard(files, shardIndex, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer.');
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex must be between 0 and ${shardCount - 1}.`);
  }

  return files.filter((_file, index) => index % shardCount === shardIndex);
}

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
  if (shardCount !== 1) {
    return [[...workspace, 'test:files', '--', ...selectedFiles]];
  }

  // Node/tsx discovery omits TSX. Keep discovery for the larger TypeScript
  // suite, then explicitly run React tests in bounded Windows-safe batches.
  const commands = [[...workspace, 'test']];
  const reactFiles = selectedFiles.filter((file) => file.endsWith('.tsx'));
  for (let index = 0; index < reactFiles.length; index += 32) {
    commands.push([...workspace, 'test:files', '--', ...reactFiles.slice(index, index + 32)]);
  }
  return commands;
}

export async function runAppTests({ shardIndex = 0, shardCount = 1 } = {}) {
  const files = listDiscoveredAppTests();
  const commands = createAppTestCommands(files, shardIndex, shardCount);

  // App tests import Core through its published ESM export. Build that
  // prerequisite here so local full and sharded App-test runs are self-contained;
  // CI independently verifies the restored artifact before this runner starts.
  await run(['workspace', '@valerypopoff/rivet2-core', 'run', 'build:esm']);

  if (shardCount !== 1) {
    console.log(`[app-tests] Running shard ${shardIndex + 1}/${shardCount}: ${commands[0].length - 5} files.`);
  }
  for (const command of commands) {
    await run(command);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const shardIndex = parseIntegerFlag(args, '--shard-index', 0);
  const shardCount = parseIntegerFlag(args, '--shard-count', 1);
  if (args.includes('--check')) {
    const files = listDiscoveredAppTests();
    selectAppTestShard(files, shardIndex, shardCount);
    console.log(`[app-tests] Discovered ${files.length} tests; shard ${shardIndex + 1}/${shardCount} is valid.`);
    return;
  }
  await runAppTests({ shardIndex, shardCount });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
