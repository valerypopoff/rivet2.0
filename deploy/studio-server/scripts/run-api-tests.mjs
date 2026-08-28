import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultApiTestFiles, kubernetesApiTestFiles } from './api-test-files.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..', '..');
const apiRoot = path.join(rootDir, 'packages', 'studio-server-api');

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

export function selectApiTestShard(files, shardIndex, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer.');
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex must be between 0 and ${shardCount - 1}.`);
  }
  return files.filter((_file, index) => index % shardCount === shardIndex);
}

export function listApiTestFiles(testsDirectory, relativeDirectory = 'src/tests') {
  return fs
    .readdirSync(testsDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        return listApiTestFiles(path.join(testsDirectory, entry.name), relativePath);
      }
      return entry.isFile() && /\.test\.(?:ts|mts)$/.test(entry.name) ? [relativePath] : [];
    })
    .sort();
}

export function listDiscoveredApiTests() {
  return listApiTestFiles(path.join(apiRoot, 'src', 'tests'));
}

export function verifyApiTestManifest() {
  const allManifestFiles = [...defaultApiTestFiles, ...kubernetesApiTestFiles];
  const duplicates = allManifestFiles.filter((file, index) => allManifestFiles.indexOf(file) !== index);
  if (duplicates.length > 0) {
    throw new Error(`API test manifest contains duplicate entries: ${[...new Set(duplicates)].join(', ')}`);
  }
  const sortedManifest = [...allManifestFiles].sort();
  const discovered = listDiscoveredApiTests();
  if (JSON.stringify(sortedManifest) !== JSON.stringify(discovered)) {
    const missing = discovered.filter((file) => !sortedManifest.includes(file));
    const stale = sortedManifest.filter((file) => !discovered.includes(file));
    throw new Error(
      `API test manifest is stale. Missing: ${missing.join(', ') || 'none'}. Stale: ${stale.join(', ') || 'none'}.`,
    );
  }
  if (JSON.stringify(defaultApiTestFiles) !== JSON.stringify([...defaultApiTestFiles].sort())) {
    throw new Error('Default API test manifest must remain sorted for deterministic sharding.');
  }
}

export async function runApiTests({ shardIndex = 0, shardCount = 1 } = {}) {
  verifyApiTestManifest();
  const selectedFiles = selectApiTestShard(defaultApiTestFiles, shardIndex, shardCount);
  if (selectedFiles.length === 0) {
    throw new Error(`API test shard ${shardIndex + 1}/${shardCount} is empty.`);
  }

  console.log(`[api-tests] Running shard ${shardIndex + 1}/${shardCount}: ${selectedFiles.length} files.`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      'yarn',
      ['workspace', '@valerypopoff/rivet-studio-server-api', 'run', 'test:files', ...selectedFiles],
      {
        cwd: rootDir,
        env: process.env,
        shell: process.platform === 'win32',
        stdio: 'inherit',
      },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`API test shard exited with code ${code ?? 'unknown'}.`));
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const shardIndex = parseIntegerFlag(args, '--shard-index', 0);
  const shardCount = parseIntegerFlag(args, '--shard-count', 1);
  if (args.includes('--check')) {
    verifyApiTestManifest();
    console.log(
      `[api-tests] Manifest covers ${defaultApiTestFiles.length} default and ${kubernetesApiTestFiles.length} Kubernetes tests.`,
    );
    return;
  }
  await runApiTests({ shardIndex, shardCount });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
