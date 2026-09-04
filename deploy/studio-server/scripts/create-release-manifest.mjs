import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS,
  assertStudioServerReleasePredecessor,
  assertStudioServerReleaseManifest,
  createStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function parseArgs(argv) {
  const [command = 'create', ...rest] = argv;
  const supportedOptions =
    command === 'create'
      ? new Set([
          '--output',
          '--source-repository',
          '--source-ref',
          '--source-sha',
          '--workflow',
          '--run-id',
          '--run-attempt',
          '--image',
          '--predecessor',
        ])
      : command === 'promote'
        ? new Set(['--input', '--output', '--workflow', '--run-id', '--run-attempt', '--current'])
        : command === 'digest'
          ? new Set(['--input'])
          : null;
  if (!supportedOptions) {
    throw new Error(`Unknown command "${command}". Expected create, promote, or digest.`);
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument "${key}"`);
    }
    if (!supportedOptions.has(key)) {
      throw new Error(`Unknown option "${key}" for ${command}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${key} requires a value`);
    }
    if (options.has(key)) {
      throw new Error(`${key} may only be supplied once`);
    }
    options.set(key, value);
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = options.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

/**
 * Release evidence is intentionally repository-owned. Keeping both input and
 * output beneath the checkout makes the CLI agree with the deployment tool
 * and prevents a mistyped relative path from silently reading or overwriting
 * an operator's unrelated files.
 */
function repositoryPath(options, key) {
  const resolved = path.resolve(rootDir, required(options, key));
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${key} must remain inside this repository`);
  }
  return resolved;
}

function optionalRepositoryPath(options, key) {
  return options.has(key) ? repositoryPath(options, key) : null;
}

function readManifest(manifestPath, { requirePromoted = false } = {}) {
  return assertStudioServerReleaseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), { requirePromoted });
}

function parseRunAttempt(options) {
  const value = Number(required(options, '--run-attempt'));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--run-attempt must be a positive integer');
  }
  return value;
}

function parseImage(value) {
  const separator = value.indexOf('=');
  if (separator < 1) {
    throw new Error(`Invalid --image "${value}". Expected component=repository@sha256:digest.`);
  }
  const component = value.slice(0, separator);
  const reference = value.slice(separator + 1);
  const digestSeparator = reference.lastIndexOf('@');
  if (!STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS.includes(component) || digestSeparator < 1) {
    throw new Error(`Invalid --image "${value}". Expected a known component and repository@sha256:digest.`);
  }
  return [component, { repository: reference.slice(0, digestSeparator), digest: reference.slice(digestSeparator + 1) }];
}

function parseImages(options) {
  const rawImages = options.get('--image');
  if (!rawImages) {
    throw new Error('--image is required once for every image component');
  }
  // Repeatable CLI flags are represented as one comma-separated value so the
  // command stays portable across PowerShell, Bash, and GitHub Actions.
  const parsedImages = rawImages.split(',').map(parseImage);
  const images = Object.fromEntries(parsedImages);
  if (
    parsedImages.length !== STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS.length ||
    Object.keys(images).length !== STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS.length
  ) {
    throw new Error('--image must include proxy, web, api, and executor exactly once');
  }
  return images;
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function evidenceFrom(options) {
  return {
    workflow: required(options, '--workflow'),
    runId: required(options, '--run-id'),
    runAttempt: parseRunAttempt(options),
  };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'digest') {
    const manifest = readManifest(repositoryPath(options, '--input'), { requirePromoted: true });
    console.log(getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true }));
    return;
  }

  const outputPath = repositoryPath(options, '--output');
  if (command === 'create') {
    const predecessorPath = optionalRepositoryPath(options, '--predecessor');
    const manifest = createStudioServerReleaseManifest({
      rootDir,
      source: {
        repository: required(options, '--source-repository'),
        ref: required(options, '--source-ref'),
        sha: required(options, '--source-sha'),
      },
      images: parseImages(options),
      candidateEvidence: evidenceFrom(options),
      predecessorRelease: predecessorPath ? readManifest(predecessorPath, { requirePromoted: true }) : null,
    });
    writeJson(outputPath, manifest);
    console.log(`Wrote candidate Studio Server release manifest to ${path.relative(rootDir, outputPath)}.`);
    return;
  }

  if (command === 'promote') {
    const inputPath = repositoryPath(options, '--input');
    const currentPath = optionalRepositoryPath(options, '--current');
    const candidate = readManifest(inputPath);
    assertStudioServerReleasePredecessor(
      candidate,
      currentPath ? readManifest(currentPath, { requirePromoted: true }) : null,
    );
    const manifest = promoteStudioServerReleaseManifest(candidate, { promotionEvidence: evidenceFrom(options) });
    writeJson(outputPath, manifest);
    console.log(`Wrote promoted Studio Server release manifest to ${path.relative(rootDir, outputPath)}.`);
    return;
  }

  throw new Error(`Unsupported command "${command}".`);
}

try {
  main();
} catch (error) {
  console.error(`[create-release-manifest] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
