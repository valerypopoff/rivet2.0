import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dockerfile = path.join(rootDir, 'deploy', 'studio-server', 'images', 'release-manifest', 'Dockerfile');
const referencePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const manifestDigestPattern = /^sha256:[a-f0-9]{64}$/u;

function splitImageReference(reference) {
  if (!referencePattern.test(reference)) {
    throw new Error('Image reference must be a registry tag such as ghcr.io/owner/repository:tag');
  }
  const separator = reference.lastIndexOf(':');
  return { repository: reference.slice(0, separator), tag: reference.slice(separator + 1) };
}

export function isMissingRegistryManifestError(output) {
  return /manifest unknown|name unknown|unknown tag|repository (?:does not exist|not found)/iu.test(output);
}

export function assertContentAddressedManifestReference(reference, manifestDigest) {
  if (!manifestDigestPattern.test(manifestDigest)) {
    throw new Error('Release-manifest semantic digest must be a lowercase SHA-256 digest');
  }
  const { tag } = splitImageReference(reference);
  const expectedTag = `manifest-${manifestDigest.replace(/^sha256:/u, '')}`;
  if (tag !== expectedTag) {
    throw new Error(`Release-manifest reference must use its semantic digest tag ${expectedTag}; received ${tag}`);
  }
  return reference;
}

export function assertProductionManifestRetag({ source, destination, manifestDigest }) {
  const sourceReference = splitImageReference(source);
  const destinationReference = splitImageReference(destination);
  assertContentAddressedManifestReference(source, manifestDigest);
  if (destinationReference.tag !== 'production') {
    throw new Error('Release-manifest retag destination must be the production pointer');
  }
  if (sourceReference.repository !== destinationReference.repository) {
    throw new Error('Release-manifest source and production pointer must use the same repository');
  }
  return { source, destination };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const supportedOptions =
    command === 'pull'
      ? new Set(['--reference', '--output', '--allow-missing'])
      : command === 'push'
        ? new Set(['--reference', '--input'])
        : command === 'retag'
          ? new Set(['--source', '--destination'])
          : null;
  if (!supportedOptions) {
    throw new Error('Expected pull, push, or retag.');
  }

  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!supportedOptions.has(key)) throw new Error(`Unknown option "${key}" for ${command}`);
    if (options.has(key)) throw new Error(`${key} may only be supplied once`);
    if (key === '--allow-missing') {
      options.set(key, true);
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    options.set(key, value);
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function repositoryPath(options, key) {
  const resolved = path.resolve(rootDir, required(options, key));
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${key} must remain inside this repository`);
  }
  return resolved;
}

function imageReference(options, key) {
  const reference = required(options, key);
  try {
    splitImageReference(reference);
  } catch {
    throw new Error(`${key} must be a registry image tag such as ghcr.io/owner/repository:tag`);
  }
  return reference;
}

function commandLine(program, args) {
  return [program, ...args].map((value) => (/\s|"/u.test(value) ? JSON.stringify(value) : value)).join(' ');
}

async function run(program, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: rootDir,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      const exitCode = code ?? 1;
      const result = { exitCode, stdout, stderr };
      if (exitCode === 0 || allowFailure) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `Command failed with exit code ${exitCode}: ${commandLine(program, args)}${stderr ? `\n${stderr}` : ''}`,
        ),
      );
    });
  });
}

async function readPromotedManifest(inputPath) {
  return assertStudioServerReleaseManifest(JSON.parse(await fs.readFile(inputPath, 'utf8')), {
    requirePromoted: true,
  });
}

async function pullManifest(reference, outputPath, { allowMissing }) {
  await fs.rm(outputPath, { force: true });
  const pull = await run('docker', ['pull', reference], { allowFailure: true });
  if (pull.exitCode !== 0) {
    const missing = isMissingRegistryManifestError(`${pull.stdout}\n${pull.stderr}`);
    if (allowMissing && missing) {
      console.log(`No promoted release-manifest artifact exists at ${reference}.`);
      return null;
    }
    throw new Error(`Could not pull ${reference}: ${pull.stderr || pull.stdout}`);
  }

  const created = await run('docker', ['create', reference]);
  const containerId = created.stdout.trim();
  if (!containerId) throw new Error(`Docker did not return a container ID for ${reference}`);
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await run('docker', ['cp', `${containerId}:/release-manifest.json`, outputPath]);
    const manifest = await readPromotedManifest(outputPath);
    await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(
      `Pulled promoted release manifest ${getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true })} from ${reference}.`,
    );
    return manifest;
  } finally {
    await run('docker', ['rm', '--force', containerId], { allowFailure: true });
  }
}

async function pushManifest(reference, inputPath) {
  const manifest = await readPromotedManifest(inputPath);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-release-manifest-oci-'));
  try {
    const manifestDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
    assertContentAddressedManifestReference(reference, manifestDigest);
    const existingPath = path.join(temporaryDirectory, 'existing-release-manifest.json');
    const existing = await pullManifest(reference, existingPath, { allowMissing: true });
    if (existing) {
      const existingDigest = getStudioServerReleaseManifestDigest(existing, { requirePromoted: true });
      if (existingDigest !== manifestDigest) {
        throw new Error(
          `Refusing to overwrite content-addressed release-manifest tag ${reference}: it contains ${existingDigest}, expected ${manifestDigest}`,
        );
      }
      console.log(`Content-addressed release manifest already exists at ${reference}.`);
      return;
    }

    await fs.writeFile(
      path.join(temporaryDirectory, 'release-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    await run('docker', [
      'buildx',
      'build',
      '--file',
      dockerfile,
      '--platform',
      'linux/amd64',
      '--provenance=false',
      '--sbom=false',
      '--push',
      '--tag',
      reference,
      temporaryDirectory,
    ]);
    console.log(`Published promoted release manifest ${manifestDigest} to ${reference}.`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function retagManifest(source, destination) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-release-manifest-retag-'));
  try {
    const manifest = await pullManifest(source, path.join(temporaryDirectory, 'release-manifest.json'), {
      allowMissing: false,
    });
    const manifestDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
    assertProductionManifestRetag({ source, destination, manifestDigest });
    await run('docker', ['buildx', 'imagetools', 'create', '--tag', destination, source]);
    console.log(`Advanced ${destination} to promoted release manifest ${manifestDigest}.`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'pull') {
    await pullManifest(imageReference(options, '--reference'), repositoryPath(options, '--output'), {
      allowMissing: options.get('--allow-missing') === true,
    });
    return;
  }
  if (command === 'push') {
    await pushManifest(imageReference(options, '--reference'), repositoryPath(options, '--input'));
    return;
  }
  await retagManifest(imageReference(options, '--source'), imageReference(options, '--destination'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release-manifest-oci] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
