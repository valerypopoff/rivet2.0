import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeServerEnvironment } from './lib/server-launch-mode.mjs';
import { parseEnvFile } from './lib/env.mjs';
import {
  containerCredentialDefaults,
  containerServerConfig,
  createManagedCompose,
  serializeManagedCompose,
  containerStorageIdentity,
} from './lib/container-server-config.mjs';
import {
  assertContainerInstallationOwned,
  assertContainerDeploymentEvidence,
  startContainerInstallation,
  stopContainerInstallation,
  retireLegacyEvaluationContainers,
} from './lib/container-server-lifecycle.mjs';
import {
  assertStudioServerReleaseManifest,
  assertStudioServerReleasePredecessor,
  getStudioServerReleaseManifestDigest,
  assertReleaseManifestMatchesCurrentChart,
} from './lib/studio-server-release-manifest.mjs';
import {
  assertCleanTrackedCheckout,
  assertReleaseManifestMatchesCurrentCheckout,
} from './deploy-kubernetes-release.mjs';
import { withLauncherProgress } from './lib/launcher-progress.mjs';
import {
  ensureContainerStateDirectory,
  writeContainerState,
  containerProcessEnvironment,
  readContainerState,
} from './lib/container-server-files.mjs';

export function parseContainerArgs(argv) {
  const result = {};
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--manifest', '--confirm', '--stop', '--offline', '--config'].includes(key) || key in result)
      throw new Error('Unknown or duplicate container launcher option.');
    if (['--stop', '--offline', '--config'].includes(key)) result[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
      result[key] = value;
    }
  }
  if (result['--stop'] && (result['--offline'] || result['--config']))
    throw new Error('Stop cannot be combined with migration/config options.');
  return result;
}

export function containerStartupMessage(config, { restoreRecovery = false } = {}) {
  const login =
    config.uiAuthMode === 'oauth'
      ? 'Sign in using your configured OAuth provider. A fresh installation needs key-mode setup of the OAuth provider and administrator emails first.'
      : 'Sign in using the selected tier key or RIVET_KEY in your shared .env.';
  const watching =
    config.stage === 'dev'
      ? ' Frontend source watching is enabled; successful builds refresh when unsaved edits and active work permit it.'
      : '';
  return restoreRecovery
    ? `Rivet restore recovery: http://127.0.0.1:${config.port}/?restore-legacy-backup. ${login} The pending restore was retained. Finish or cancel it in the UI before deployment migration; no schema migration or settings seeding was run.`
    : `Rivet started: http://127.0.0.1:${config.port}. ${login}${watching} Existing data was not imported or deleted.`;
}

function run(program, args, { capture = false, acceptedExitCodes = [], ...options } = {}) {
  // The shared dotenv is NOT an env_file for serving containers. Only the
  // normalized configuration reaches Docker; never pass host PnP preloads.
  const env = containerProcessEnvironment(process.env);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      ...options,
    });
    let stdout = '',
      stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || acceptedExitCodes.includes(code)) return resolve({ stdout, stderr, exitCode: code });
      const error = new Error(
        `${path.basename(program)} ${args[0]} failed (${code}).${capture ? ' Inspect the installation with Docker; private configuration was not logged.' : ''}`,
      );
      error.exitCode = code;
      reject(error);
    });
  });
}

async function main() {
  const [stage, storage, ...argv] = process.argv.slice(2);
  const options = parseContainerArgs(argv);
  const root = process.cwd();
  const envPath = path.resolve(root, process.env.RIVET_ENV_FILE || '.env');
  if (!['dev', 'staging', 'prod'].includes(stage) || !['local-storage', 'external-storage'].includes(storage))
    throw new Error('Select dev/staging/prod and local-storage/external-storage.');
  if (!options['--stop'] && storage === 'local-storage') {
    initializeServerEnvironment(root, process.env.RIVET_ENV_FILE, (source) => ({
      ...(!source.RIVET_KEY && !source[`RIVET_${stage.toUpperCase()}_KEY`]
        ? { RIVET_KEY: randomBytes(32).toString('hex') }
        : {}),
      ...Object.fromEntries(
        containerCredentialDefaults(stage, storage, source).map(([name, fixed]) => [
          name,
          fixed || randomBytes(32).toString('hex'),
        ]),
      ),
    }));
  }
  if (!fs.existsSync(envPath) || !fs.lstatSync(envPath).isFile()) throw new Error('Select a regular shared .env file.');
  const config = containerServerConfig(parseEnvFile(envPath), stage, storage, root);
  if (stage !== 'dev' && options['--confirm'] !== config.project && !options['--config'])
    throw new Error(`Confirm this installation with --confirm ${config.project}.`);
  if (options['--offline'] && options['--confirm'] !== config.project)
    throw new Error(
      'An external incompatible cutover requires explicit installation confirmation and every database consumer stopped.',
    );
  const dir = ensureContainerStateDirectory(root, config.project);
  const lockPath = path.join(dir, 'launcher.lock');
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'This installation already has a launcher owner. After a crash, stop the previous runner before removing launcher.lock.',
      );
    throw error;
  }
  try {
    const dockerBin = process.env.RIVET_K8S_DOCKER_BIN || 'docker';
    const docker = (args, extra) => run(dockerBin, args, extra);
    const composePath = path.join(dir, 'compose.private.json');
    const compose = (args, extra) =>
      withLauncherProgress('container-server', `Docker ${args[0]}`, () =>
        docker(['compose', '-p', config.project, '-f', composePath, ...args], extra),
      );
    let manifest;
    let digest = '';
    let images;
    const statePath = path.join(dir, 'release.json');
    const pendingPath = path.join(dir, 'pending.json');
    const recorded = readContainerState(statePath);
    const installed = recorded === null ? null : JSON.parse(recorded);
    if (stage === 'dev') {
      if (options['--manifest'])
        throw new Error('Development builds the checkout; staging/prod use immutable manifests.');
      const tag = `source-${Date.now()}-${process.pid}`;
      images = Object.fromEntries(['api', 'web', 'proxy'].map((name) => [name, `rivet-local/${name}:${tag}`]));
    } else {
      if (!options['--manifest'] && !options['--stop'])
        throw new Error('Staging/prod require --manifest with immutable image evidence.');
      manifest = options['--manifest']
        ? assertStudioServerReleaseManifest(
            JSON.parse(fs.readFileSync(path.resolve(root, options['--manifest']), 'utf8')),
            { requirePromoted: stage === 'prod' },
          )
        : installed;
      if (!manifest) throw new Error('Installed release evidence is unavailable.');
      digest = getStudioServerReleaseManifestDigest(manifest, { requirePromoted: stage === 'prod' });
      if (!options['--stop']) {
        await assertCleanTrackedCheckout();
        if (stage === 'prod') {
          await assertReleaseManifestMatchesCurrentCheckout(manifest);
          assertReleaseManifestMatchesCurrentChart(manifest, root);
        } else {
          const sha = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).stdout.trim();
          if (manifest.source.sha !== sha) throw new Error('Staging manifest must match the clean checkout.');
        }
        if (
          manifest.database.managedWorkflowSchema.version !== config.schema.version ||
          manifest.database.managedWorkflowSchema.minimumRollbackCompatibleVersion !==
            config.schema.minimumRollbackCompatibleVersion
        )
          throw new Error('Manifest schema policy does not match this launcher checkout.');
        if (stage === 'prod' && (!installed || getStudioServerReleaseManifestDigest(installed) !== digest))
          assertStudioServerReleasePredecessor({ ...manifest, state: 'candidate' }, installed);
      }
      images = Object.fromEntries(
        Object.entries(manifest.images).map(([name, image]) => [name, `${image.repository}@${image.digest}`]),
      );
    }
    const model = createManagedCompose(config, images, {
      offline: config.local || options['--offline'] === true,
      releaseDigest: digest,
      sourceRoot: root,
    });
    if (options['--config']) {
      console.log(
        `Validated ${stage}/${storage}: project=${config.project}, local dependencies=${config.local}, UI auth=${config.uiAuthMode}, URL=http://127.0.0.1:${config.port}. Credentials were not printed; no Docker state changed.`,
      );
      return;
    }
    const verifyInstallation = async () => {
      const containers = await assertContainerInstallationOwned(config, docker, model);
      const pending = readContainerState(pendingPath);
      assertContainerDeploymentEvidence(config, containers, {
        selectedDigest: digest,
        installedDigest: installed ? getStudioServerReleaseManifestDigest(installed) : null,
        pending: pending === null ? null : JSON.parse(pending),
      });
      return containers;
    };
    const containers = await verifyInstallation();
    if (options['--stop']) {
      if (containers.length && readContainerState(composePath) === null)
        throw new Error('The installation configuration is missing; restore it before shutdown.');
      if (containers.length) {
        await retireLegacyEvaluationContainers(config, docker, containers);
        await stopContainerInstallation(config, compose);
      }
      return;
    }
    if (stage === 'dev') ensureContainerDevelopmentMountPoints(root);
    writeContainerState(composePath, serializeManagedCompose(model));
    if (stage === 'dev') {
      for (const name of ['api', 'web', 'proxy'])
        await withLauncherProgress('container-server', `Building ${name}`, () =>
          docker(containerDevelopmentBuildArgs(name, images[name])),
        );
    } else
      for (const name of ['api', 'web', 'proxy'])
        await withLauncherProgress('container-server', `Pulling ${name}`, () => docker(['pull', images[name]]));
    // Builds/pulls can take minutes; never drain or migrate from a stale inventory.
    const verifiedContainers = await verifyInstallation();
    writeContainerState(
      pendingPath,
      JSON.stringify({ project: config.project, storageIdentity: containerStorageIdentity(config), digest }),
    );
    await retireLegacyEvaluationContainers(config, docker, verifiedContainers);
    const startup = await startContainerInstallation(config, compose);
    if (manifest) writeContainerState(statePath, JSON.stringify(manifest));
    fs.unlinkSync(pendingPath);
    console.log(containerStartupMessage(config, startup));
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
export function containerDevelopmentBuildArgs(name, image) {
  return [
    'build',
    '-f',
    `deploy/studio-server/images/${name}/Dockerfile`,
    ...(name === 'web' ? ['--target', 'development'] : []),
    '-t',
    image,
    '.',
  ];
}
export function ensureContainerDevelopmentMountPoints(root) {
  // The nested dependency tmpfs needs a mountpoint in the readonly source bind.
  // PnP checkouts may not have this directory; never install host dependencies.
  fs.mkdirSync(path.join(root, 'packages/studio-server-web/node_modules'), { recursive: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
