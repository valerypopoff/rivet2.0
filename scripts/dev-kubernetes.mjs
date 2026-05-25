import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadDevEnv } from './lib/dev-env.mjs';
import { assertNoRetiredEnv } from './lib/docker-launcher-env.mjs';
import { assertValidPort, ensurePortAvailable } from './lib/docker-launcher.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import {
  buildImageRef,
  buildKubernetesLauncherConfig,
  renderKubernetesLauncherSecretManifest,
  renderKubernetesLauncherValuesYaml,
} from './lib/kubernetes-launcher-config.mjs';
import { prepareRivetDockerContext } from './lib/rivet-source-context.mjs';

const rootDir = process.cwd();
const action = process.argv[2] == null ? 'dev' : process.argv[2];
const launcherName = 'dev-kubernetes';
const stateDir = path.join(rootDir, '.data', 'kubernetes-test');

function quoteArg(arg) {
  if (!/\s|"/.test(arg)) {
    return arg;
  }

  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function resolveKubectlBin(env) {
  const explicit = String(env.RIVET_K8S_KUBECTL_BIN ?? '').trim();
  if (explicit) {
    return explicit;
  }

  return process.platform === 'win32' ? 'kubectl.exe' : 'kubectl';
}

function resolveDockerBin(env) {
  const explicit = String(env.RIVET_K8S_DOCKER_BIN ?? '').trim();
  if (explicit) {
    return explicit;
  }

  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

function resolveMinikubeBin(env) {
  const explicit = String(env.RIVET_K8S_MINIKUBE_BIN ?? '').trim();
  if (explicit) {
    return explicit;
  }

  return process.platform === 'win32' ? 'minikube.exe' : 'minikube';
}

function spawnProgram(program, args, options = {}) {
  const {
    cwd = rootDir,
    env = process.env,
    allowFailure = false,
    capture = false,
    input = null,
    detached = false,
    stdio = 'inherit',
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      detached,
      windowsHide: true,
      stdio: capture ? ['pipe', 'pipe', 'pipe'] : input != null ? ['pipe', stdio, stdio] : stdio,
    });

    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    if (input != null && child.stdin) {
      child.stdin.end(input);
    }

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0 || allowFailure) {
        resolve({ exitCode, stdout, stderr });
        return;
      }

      const commandLine = [program, ...args].map(quoteArg).join(' ');
      reject(new Error(`Command failed with exit code ${exitCode}: ${commandLine}${stderr ? `\n${stderr}` : ''}`.trim()));
    });
  });
}

async function ensureCommandWorks(program, args, label, env) {
  try {
    await spawnProgram(program, args, { env, capture: true });
  } catch (error) {
    throw new Error(`[${launcherName}] ${label} is not available: ${error.message}`);
  }
}

async function commandWorks(program, args, env) {
  try {
    await spawnProgram(program, args, { env, capture: true });
    return true;
  } catch {
    return false;
  }
}

function inferLocalClusterProvider(context, explicitProvider) {
  const normalizedExplicitProvider = String(explicitProvider ?? '').trim().toLowerCase();
  if (normalizedExplicitProvider) {
    return normalizedExplicitProvider;
  }

  if (context === 'docker-desktop') {
    return 'docker-desktop';
  }

  if (context === 'minikube' || context.startsWith('minikube-')) {
    return 'minikube';
  }

  return 'generic';
}

async function readCurrentKubectlContext(kubectlBin, env) {
  try {
    const currentContext = await spawnProgram(kubectlBin, ['config', 'current-context'], {
      env,
      capture: true,
      allowFailure: true,
    });
    if (currentContext.exitCode !== 0) {
      return null;
    }

    const context = currentContext.stdout.trim();
    return context || null;
  } catch {
    return null;
  }
}

async function resolveLauncherEnvOverrides(action, kubectlBin, minikubeBin, env) {
  if (action === 'build' || String(env.RIVET_K8S_CONTEXT ?? '').trim()) {
    return {};
  }

  const currentContext = await readCurrentKubectlContext(kubectlBin, env);
  if (currentContext) {
    return {
      RIVET_K8S_CONTEXT: currentContext,
      RIVET_K8S_CLUSTER_PROVIDER: inferLocalClusterProvider(currentContext, env.RIVET_K8S_CLUSTER_PROVIDER),
    };
  }

  if (await commandWorks(minikubeBin, ['version'], env)) {
    return {
      RIVET_K8S_CONTEXT: 'minikube',
      RIVET_K8S_CLUSTER_PROVIDER: 'minikube',
      RIVET_K8S_MINIKUBE_PROFILE: String(env.RIVET_K8S_MINIKUBE_PROFILE ?? '').trim() || 'minikube',
    };
  }

  return {};
}

function getChartName() {
  const chartYaml = fs.readFileSync(path.join(rootDir, 'charts', 'Chart.yaml'), 'utf8');
  const match = chartYaml.match(/^name:\s*(.+)$/m);
  if (!match) {
    throw new Error(`[${launcherName}] Could not determine chart name from charts/Chart.yaml`);
  }

  return match[1].trim();
}

function getStatePaths(config) {
  const baseName = config.release;
  return {
    valuesPath: path.join(stateDir, `${baseName}.values.generated.yaml`),
    statePath: path.join(stateDir, `${baseName}.state.json`),
    portForwardLogPath: path.join(stateDir, `${baseName}.port-forward.log`),
    imageArchivePath: path.join(stateDir, `${baseName}.images.tar`),
  };
}

function readState(config) {
  const { statePath } = getStatePaths(config);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(config, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const { statePath } = getStatePaths(config);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function removeState(config) {
  const { statePath } = getStatePaths(config);
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid);
  } catch {
    // Ignore stale pid values.
  }
}

function waitForPortClosed(port, timeoutMs = 15000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new net.Socket();

      socket.once('connect', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for localhost:${port} to stop accepting connections.`));
          return;
        }

        setTimeout(attempt, 250);
      });

      socket.once('error', () => {
        socket.destroy();
        resolve();
      });

      socket.connect(port, '127.0.0.1');
    };

    attempt();
  });
}

async function stopPortForward(config) {
  const state = readState(config);
  if (!state?.portForwardPid) {
    return;
  }

  killProcess(state.portForwardPid);
  try {
    await waitForPortClosed(config.localPort, 5000);
  } catch {
    // Let the later port-availability check produce the actionable error if something else is still bound.
  }
}

function getAppUrls(config) {
  const baseUrl = `http://127.0.0.1:${config.localPort}`;
  if (!config.routeConfig.requireUiGateKey) {
    return { baseUrl, browserUrl: baseUrl };
  }

  const gatedUrl = `${baseUrl}/?token=${encodeURIComponent(config.sharedKey)}`;
  return { baseUrl, browserUrl: gatedUrl };
}

function waitForPortOpen(port, timeoutMs = 15000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new net.Socket();

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for localhost:${port} to accept connections.`));
          return;
        }

        setTimeout(attempt, 250);
      });

      socket.connect(port, '127.0.0.1');
    };

    attempt();
  });
}

function withKubectlContext(config, args) {
  return ['--context', config.context, ...args];
}

function withHelmContext(config, args) {
  return ['--kube-context', config.context, ...args];
}

async function assertKubectlContext(kubectlBin, config, env) {
  const contextLookup = await spawnProgram(kubectlBin, ['config', 'get-contexts', config.context, '-o', 'name'], {
    env,
    capture: true,
    allowFailure: true,
  });
  if (contextLookup.exitCode !== 0 || contextLookup.stdout.trim() !== config.context) {
    throw new Error(`[${launcherName}] Kubernetes context "${config.context}" was not found in kubectl config.`);
  }

  await spawnProgram(kubectlBin, withKubectlContext(config, ['get', 'nodes']), { env });
}

async function readMinikubeStatus(minikubeBin, config, env) {
  const profile = config.minikubeProfile ?? config.context;
  const status = await spawnProgram(minikubeBin, ['-p', profile, 'status', '-o', 'json'], {
    env,
    capture: true,
    allowFailure: true,
  });
  if (status.exitCode !== 0) {
    return null;
  }

  try {
    return JSON.parse(status.stdout);
  } catch {
    return null;
  }
}

function isMinikubeReady(status) {
  if (!status || typeof status !== 'object') {
    return false;
  }

  const host = String(status.Host ?? '').toLowerCase();
  const kubelet = String(status.Kubelet ?? '').toLowerCase();
  const apiServer = String(status.APIServer ?? '').toLowerCase();
  const kubeconfig = String(status.Kubeconfig ?? '').toLowerCase();
  return host === 'running' &&
    kubelet === 'running' &&
    apiServer === 'running' &&
    (kubeconfig === 'configured' || kubeconfig === 'running');
}

async function ensureMinikubeReady(minikubeBin, config, env, { autoStart = false } = {}) {
  const profile = config.minikubeProfile ?? config.context;
  const status = await readMinikubeStatus(minikubeBin, config, env);
  if (isMinikubeReady(status)) {
    return;
  }

  if (!autoStart) {
    throw new Error(
      `[${launcherName}] Minikube profile "${profile}" is not running. ` +
      `Run "minikube start -p ${profile}" or set RIVET_K8S_CONTEXT to another reachable cluster.`,
    );
  }

  console.log(`[${launcherName}] Starting Minikube profile "${profile}"...`);
  await spawnProgram(minikubeBin, ['-p', profile, 'start'], { env });
}

function renderValuesFile(config) {
  fs.mkdirSync(stateDir, { recursive: true });
  const { valuesPath } = getStatePaths(config);
  fs.writeFileSync(valuesPath, renderKubernetesLauncherValuesYaml(config), 'utf8');
  return valuesPath;
}

async function applySecrets(kubectlBin, config, env) {
  const manifest = renderKubernetesLauncherSecretManifest(config);
  await spawnProgram(kubectlBin, withKubectlContext(config, ['apply', '-f', '-']), {
    env,
    input: manifest,
  });
}

async function buildImages(dockerBin, config, env) {
  const buildSpecs = [
    { dockerfile: 'image/api/Dockerfile', image: config.images.api, needsRivetSource: true },
    { dockerfile: 'image/executor/Dockerfile', image: config.images.executor, needsRivetSource: true },
    { dockerfile: 'image/web/Dockerfile', image: config.images.web, needsRivetSource: true },
    { dockerfile: 'image/proxy/Dockerfile', image: config.images.proxy },
  ];
  const rivetSourceBuildContextPath = prepareRivetDockerContext(rootDir, env);
  const rivetDependencyBuildContextPath = env.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH;

  for (const spec of buildSpecs) {
    const buildContextArgs = spec.needsRivetSource
      ? [
          '--build-context',
          `rivet_source=${rivetSourceBuildContextPath}`,
          '--build-context',
          `rivet_dependency_metadata=${rivetDependencyBuildContextPath}`,
        ]
      : [];
    await spawnProgram(
      dockerBin,
      ['build', ...buildContextArgs, '-f', spec.dockerfile, '-t', buildImageRef(spec.image), '.'],
      { env },
    );
  }
}

async function listClusterNodeNames(kubectlBin, config, env) {
  const result = await spawnProgram(
    kubectlBin,
    withKubectlContext(config, ['get', 'nodes', '-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}']),
    { env, capture: true },
  );

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureDockerNodeContainer(dockerBin, nodeName, env) {
  const result = await spawnProgram(dockerBin, ['inspect', nodeName], {
    env,
    capture: true,
    allowFailure: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `[${launcherName}] Kubernetes node "${nodeName}" is not accessible as a Docker container. ` +
      'For local images with pullPolicy=Never, either use a Docker-backed local cluster or set RIVET_K8S_LOAD_LOCAL_IMAGES=false and point the chart at pullable images.',
    );
  }
}

async function loadImagesIntoCluster(dockerBin, kubectlBin, config, env) {
  if (!config.loadLocalImages) {
    return;
  }

  const imageRefs = [
    buildImageRef(config.images.api),
    buildImageRef(config.images.executor),
    buildImageRef(config.images.web),
    buildImageRef(config.images.proxy),
  ];

  if (config.localClusterProvider === 'minikube') {
    const minikubeBin = resolveMinikubeBin(env);
    const profile = config.minikubeProfile ?? config.context;
    for (const imageRef of imageRefs) {
      await spawnProgram(minikubeBin, ['-p', profile, 'image', 'load', '--daemon=true', imageRef], { env });
    }
    return;
  }

  const nodeNames = await listClusterNodeNames(kubectlBin, config, env);
  if (nodeNames.length === 0) {
    throw new Error(`[${launcherName}] Could not find any Kubernetes nodes in context "${config.context}".`);
  }

  for (const nodeName of nodeNames) {
    await ensureDockerNodeContainer(dockerBin, nodeName, env);
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const { imageArchivePath } = getStatePaths(config);

  try {
    await spawnProgram(dockerBin, ['save', '-o', imageArchivePath, ...imageRefs], { env });

    for (const nodeName of nodeNames) {
      const remoteArchivePath = `/var/tmp/${config.release}.images.tar`;
      await spawnProgram(dockerBin, ['cp', imageArchivePath, `${nodeName}:${remoteArchivePath}`], { env });
      try {
        await spawnProgram(dockerBin, ['exec', nodeName, 'ctr', '-n', 'k8s.io', 'images', 'import', remoteArchivePath], { env });
      } finally {
        await spawnProgram(dockerBin, ['exec', nodeName, 'rm', '-f', remoteArchivePath], {
          env,
          allowFailure: true,
        });
      }
    }
  } finally {
    if (fs.existsSync(imageArchivePath)) {
      fs.unlinkSync(imageArchivePath);
    }
  }
}

async function helmUpgradeInstall(helmBin, config, valuesPath, env) {
  await spawnProgram(
    helmBin,
    withHelmContext(config, [
      'upgrade',
      '--install',
      config.release,
      './charts',
      '-n',
      config.namespace,
      '-f',
      './charts/overlays/local-kubernetes.yaml',
      '-f',
      valuesPath,
      '--wait',
    ]),
    { env },
  );
}

async function helmTemplate(helmBin, config, valuesPath, env) {
  await spawnProgram(
    helmBin,
    withHelmContext(config, [
      'template',
      config.release,
      './charts',
      '-n',
      config.namespace,
      '-f',
      './charts/overlays/local-kubernetes.yaml',
      '-f',
      valuesPath,
    ]),
    { env },
  );
}

async function helmLint(helmBin, valuesPath, env) {
  await spawnProgram(
    helmBin,
    ['lint', './charts', '-f', './charts/overlays/local-kubernetes.yaml', '-f', valuesPath],
    { env },
  );
}

async function printStatus(kubectlBin, config, env) {
  await spawnProgram(kubectlBin, withKubectlContext(config, ['-n', config.namespace, 'get', 'pods', '-o', 'wide']), {
    env,
    allowFailure: true,
  });
  await spawnProgram(kubectlBin, withKubectlContext(config, ['-n', config.namespace, 'get', 'deploy']), {
    env,
    allowFailure: true,
  });
  await spawnProgram(kubectlBin, withKubectlContext(config, ['-n', config.namespace, 'get', 'statefulset']), {
    env,
    allowFailure: true,
  });
  await spawnProgram(kubectlBin, withKubectlContext(config, ['-n', config.namespace, 'get', 'svc']), {
    env,
    allowFailure: true,
  });

  const state = readState(config);
  if (state?.baseUrl && state?.portForwardPid && processExists(state.portForwardPid)) {
    console.log(`[${launcherName}] App URL: ${state.baseUrl}`);
    if (state.browserUrl && state.browserUrl !== state.baseUrl) {
      console.log(`[${launcherName}] Browser URL: ${state.browserUrl}`);
    }
  }
}

async function printLogs(kubectlBin, config, env) {
  await spawnProgram(
    kubectlBin,
    withKubectlContext(config, [
      '-n',
      config.namespace,
      'logs',
      '-l',
      `app.kubernetes.io/instance=${config.release}`,
      '--all-containers=true',
      '--prefix',
      '--tail=120',
      '-f',
    ]),
    { env },
  );
}

async function uninstallRelease(helmBin, kubectlBin, config, env) {
  await spawnProgram(helmBin, withHelmContext(config, ['uninstall', config.release, '-n', config.namespace]), {
    env,
    allowFailure: true,
  });
  await spawnProgram(kubectlBin, withKubectlContext(config, ['delete', 'namespace', config.namespace, '--ignore-not-found=true']), {
    env,
    allowFailure: true,
  });
}

async function startPortForward(kubectlBin, config, env, envFileLabel) {
  await stopPortForward(config);
  await ensurePortAvailable(assertValidPort(config.localPort, 8080), {
    envFileLabel,
    label: launcherName,
  });

  const chartName = getChartName();
  const proxyServiceName = `${config.release}-${chartName}-proxy`;
  const { portForwardLogPath } = getStatePaths(config);
  const logFd = fs.openSync(portForwardLogPath, 'w');
  const child = spawn(
    kubectlBin,
    withKubectlContext(config, ['-n', config.namespace, 'port-forward', `service/${proxyServiceName}`, `${config.localPort}:80`]),
    {
      cwd: rootDir,
      env,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    },
  );

  child.unref();
  fs.closeSync(logFd);

  try {
    await waitForPortOpen(config.localPort);
  } catch (error) {
    killProcess(child.pid);
    throw error;
  }

  writeState(config, {
    namespace: config.namespace,
    release: config.release,
    localPort: config.localPort,
    ...getAppUrls(config),
    portForwardPid: child.pid,
    portForwardLogPath,
  });

  const { baseUrl, browserUrl } = getAppUrls(config);
  console.log(`[${launcherName}] App URL: ${baseUrl}`);
  if (browserUrl !== baseUrl) {
    console.log(`[${launcherName}] Browser URL: ${browserUrl}`);
  }
  console.log(`[${launcherName}] Port-forward log: ${portForwardLogPath}`);
}

async function main() {
  const { mergedEnv, envPath, hasEnvFile } = loadDevEnv(rootDir);
  const envFileLabel = hasEnvFile ? path.basename(envPath) : '.env';

  assertNoRetiredEnv(mergedEnv, { launcherName, envFileLabel });
  const kubectlBin = resolveKubectlBin(mergedEnv);
  const minikubeBin = resolveMinikubeBin(mergedEnv);
  const launcherEnvOverrides = await resolveLauncherEnvOverrides(action, kubectlBin, minikubeBin, mergedEnv);
  const effectiveEnv = {
    ...mergedEnv,
    ...launcherEnvOverrides,
  };
  const config = buildKubernetesLauncherConfig(effectiveEnv);
  const helmBin = action === 'build'
    ? null
    : resolveHelmBinOrThrow(rootDir, { env: effectiveEnv, launcherName });
  const dockerBin = resolveDockerBin(effectiveEnv);

  if (action === 'build' || action === 'dev' || action === 'recreate') {
    await ensureCommandWorks(dockerBin, ['version'], 'Docker', effectiveEnv);
  }

  if (action === 'up' && config.loadLocalImages) {
    await ensureCommandWorks(dockerBin, ['version'], 'Docker', effectiveEnv);
  }

  if (action !== 'build') {
    await ensureCommandWorks(kubectlBin, ['version', '--client'], 'kubectl', effectiveEnv);
    await ensureCommandWorks(helmBin, ['version'], 'Helm', effectiveEnv);
  }

  if (action !== 'build' && config.localClusterProvider === 'minikube') {
    await ensureCommandWorks(minikubeBin, ['version'], 'Minikube', effectiveEnv);
  }

  switch (action) {
    case 'build':
      await buildImages(dockerBin, config, effectiveEnv);
      return;
    case 'config': {
      const valuesPath = renderValuesFile(config);
      await helmLint(helmBin, valuesPath, effectiveEnv);
      await helmTemplate(helmBin, config, valuesPath, effectiveEnv);
      console.log(`[${launcherName}] Generated values file: ${valuesPath}`);
      return;
    }
    case 'ps':
      if (config.localClusterProvider === 'minikube') {
        await ensureMinikubeReady(minikubeBin, config, effectiveEnv);
      }
      await printStatus(kubectlBin, config, effectiveEnv);
      return;
    case 'logs':
      if (config.localClusterProvider === 'minikube') {
        await ensureMinikubeReady(minikubeBin, config, effectiveEnv);
      }
      await printLogs(kubectlBin, config, effectiveEnv);
      return;
    case 'down':
      await stopPortForward(config);
      await uninstallRelease(helmBin, kubectlBin, config, effectiveEnv);
      removeState(config);
      return;
    case 'up': {
      if (config.localClusterProvider === 'minikube') {
        await ensureMinikubeReady(minikubeBin, config, effectiveEnv, { autoStart: true });
      }
      await assertKubectlContext(kubectlBin, config, effectiveEnv);
      await loadImagesIntoCluster(dockerBin, kubectlBin, config, effectiveEnv);
      const valuesPath = renderValuesFile(config);
      await applySecrets(kubectlBin, config, effectiveEnv);
      try {
        await helmUpgradeInstall(helmBin, config, valuesPath, effectiveEnv);
      } catch (error) {
        await printStatus(kubectlBin, config, effectiveEnv);
        throw error;
      }

      await startPortForward(kubectlBin, config, effectiveEnv, envFileLabel);
      return;
    }
    case 'recreate':
      await stopPortForward(config);
      await uninstallRelease(helmBin, kubectlBin, config, effectiveEnv);
      removeState(config);
      await buildImages(dockerBin, config, effectiveEnv);
      if (config.localClusterProvider === 'minikube') {
        await ensureMinikubeReady(minikubeBin, config, effectiveEnv, { autoStart: true });
      }
      await assertKubectlContext(kubectlBin, config, effectiveEnv);
      await loadImagesIntoCluster(dockerBin, kubectlBin, config, effectiveEnv);
      await applySecrets(kubectlBin, config, effectiveEnv);
      await helmUpgradeInstall(helmBin, config, renderValuesFile(config), effectiveEnv);
      await startPortForward(kubectlBin, config, effectiveEnv, envFileLabel);
      return;
    case 'dev':
      await buildImages(dockerBin, config, effectiveEnv);
      if (config.localClusterProvider === 'minikube') {
        await ensureMinikubeReady(minikubeBin, config, effectiveEnv, { autoStart: true });
      }
      await assertKubectlContext(kubectlBin, config, effectiveEnv);
      await loadImagesIntoCluster(dockerBin, kubectlBin, config, effectiveEnv);
      await applySecrets(kubectlBin, config, effectiveEnv);
      await helmUpgradeInstall(helmBin, config, renderValuesFile(config), effectiveEnv);
      await startPortForward(kubectlBin, config, effectiveEnv, envFileLabel);
      return;
    default:
      console.error(`Unknown action: ${action}`);
      console.error('Usage: node scripts/dev-kubernetes.mjs [dev|recreate|build|up|down|config|ps|logs]');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
