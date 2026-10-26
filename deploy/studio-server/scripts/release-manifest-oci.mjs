import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dockerfile = path.join(rootDir, 'deploy', 'studio-server', 'images', 'release-manifest', 'Dockerfile');
const referencePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const manifestDigestPattern = /^sha256:[a-f0-9]{64}$/u;
export const PRODUCTION_RELEASE_MANIFEST_REFERENCE =
  'ghcr.io/valerypopoff/rivet2.0-studio-server/release-manifest:production';

function splitImageReference(reference) {
  if (!referencePattern.test(reference)) {
    throw new Error('Image reference must be a registry tag such as ghcr.io/owner/repository:tag');
  }
  const separator = reference.lastIndexOf(':');
  return { repository: reference.slice(0, separator), tag: reference.slice(separator + 1) };
}

export function isMissingRegistryManifestError(output, reference) {
  // Docker's containerd image store reports a missing tag differently. Accept
  // only the exact requested reference, not arbitrary "not found" diagnostics
  // from a credential helper, daemon or unrelated artifact. Mixed errors fail.
  const diagnostic = output
    .trim()
    .replace(/^Error response from daemon:\s*/u, '')
    .replace(/^ERROR:\s*/u, '');
  if (/[\r\n]/u.test(diagnostic)) return false;
  if (reference && referencePattern.test(reference)) {
    const missing = `${reference}: not found`;
    if (diagnostic === missing || diagnostic === `failed to resolve reference "${reference}": ${missing}`) return true;
  }
  // Registry/auth failures must never authorize bootstrap or publication.
  if (
    /unauthorized|forbidden|denied|authentication required|failed to authorize|error getting credentials/iu.test(
      diagnostic,
    )
  )
    return false;
  return /manifest unknown|name unknown|unknown tag|repository (?:does not exist|not found)/iu.test(diagnostic);
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
    child.once('close', (code) => {
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
  const stat = await fs.lstat(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('Release manifest must be a regular file of at most 1 MiB, not a symlink or directory.');
  return assertStudioServerReleaseManifest(JSON.parse(await fs.readFile(inputPath, 'utf8')), {
    requirePromoted: true,
  });
}

export async function pullReleaseManifestArtifact(reference, outputPath, { allowMissing = false, execute = run } = {}) {
  const { repository } = splitImageReference(reference);
  await fs.rm(outputPath, { force: true });
  const pull = await execute('docker', ['pull', reference], { allowFailure: true });
  if (pull.exitCode !== 0) {
    const missing = isMissingRegistryManifestError(`${pull.stdout}\n${pull.stderr}`, reference);
    if (allowMissing && missing) {
      console.log(`No promoted release-manifest artifact exists at ${reference}.`);
      return null;
    }
    throw new Error(
      `Could not pull ${reference}. Docker and registry access are required; CI must have promoted a production release. No cached or candidate release will be used.\n${pull.stderr || pull.stdout}`,
    );
  }

  // Resolve from this pull's acknowledgement, never inspect the mutable tag.
  // Another pull/promotion may change that tag before extraction starts.
  const digests = [...`${pull.stdout}\n${pull.stderr}`.matchAll(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/gmu)];
  if (digests.length !== 1)
    throw new Error(`Docker did not acknowledge one immutable artifact digest for ${reference}.`);
  const resolvedReference = `${repository}@${digests[0][1]}`;
  const inspected = await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', resolvedReference]);
  const imageId = inspected.stdout.trim();
  if (!manifestDigestPattern.test(imageId))
    throw new Error(`Docker returned an invalid image identity for ${resolvedReference}.`);
  // Name ownership before dispatch so even a lost create acknowledgement can be cleaned up.
  const containerName = `rivet-manifest-${randomUUID()}`;
  let temporaryDirectory;
  let result;
  let ownsOutput = false;
  const failures = [];
  try {
    const created = await execute('docker', ['create', '--name', containerName, imageId]);
    if (!created.stdout.trim()) throw new Error(`Docker did not acknowledge artifact container ${containerName}.`);
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-manifest-extract-'));
    const extractedPath = path.join(temporaryDirectory, 'release-manifest.json');
    await execute('docker', ['cp', `${containerName}:/release-manifest.json`, extractedPath]);
    const manifest = await readPromotedManifest(extractedPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const output = await fs.open(outputPath, 'wx');
    ownsOutput = true;
    try {
      await output.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    } finally {
      await output.close();
    }
    result = {
      manifest,
      identity: { reference, resolvedReference, imageId },
    };
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      const removed = await execute('docker', ['rm', '--force', '--volumes', containerName], { allowFailure: true });
      if (removed.exitCode !== 0)
        throw new Error(
          `Could not remove temporary artifact container ${containerName}: ${removed.stderr || removed.stdout}`,
        );
    } catch (error) {
      failures.push(error);
    }
    if (temporaryDirectory) {
      try {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    // Never erase somebody else's concurrently published output after an EEXIST.
    if (ownsOutput) {
      try {
        await fs.rm(outputPath, { force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, failures.map((error) => error.message).join('\n'));
  }
  console.log(
    `Pulled promoted release manifest ${getStudioServerReleaseManifestDigest(result.manifest, { requirePromoted: true })} from ${reference}.`,
  );
  return result;
}

export async function pushReleaseManifestArtifact(reference, inputPath, { execute = run } = {}) {
  const manifest = await readPromotedManifest(inputPath);
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-release-manifest-oci-'));
  try {
    const manifestDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
    assertContentAddressedManifestReference(reference, manifestDigest);
    const existingPath = path.join(temporaryDirectory, 'existing-release-manifest.json');
    const artifact = await pullReleaseManifestArtifact(reference, existingPath, { allowMissing: true, execute });
    const existing = artifact?.manifest;
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
    await execute('docker', [
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

export async function retagReleaseManifestArtifact(source, destination, { execute = run } = {}) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-release-manifest-retag-'));
  try {
    const { manifest, identity } = await pullReleaseManifestArtifact(
      source,
      path.join(temporaryDirectory, 'release-manifest.json'),
      {
        allowMissing: false,
        execute,
      },
    );
    const manifestDigest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
    assertProductionManifestRetag({ source, destination, manifestDigest });
    await execute('docker', ['buildx', 'imagetools', 'create', '--tag', destination, identity.resolvedReference]);
    console.log(`Advanced ${destination} to promoted release manifest ${manifestDigest}.`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'pull') {
    await pullReleaseManifestArtifact(imageReference(options, '--reference'), repositoryPath(options, '--output'), {
      allowMissing: options.get('--allow-missing') === true,
    });
    return;
  }
  if (command === 'push') {
    await pushReleaseManifestArtifact(imageReference(options, '--reference'), repositoryPath(options, '--input'));
    return;
  }
  await retagReleaseManifestArtifact(imageReference(options, '--source'), imageReference(options, '--destination'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[release-manifest-oci] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
