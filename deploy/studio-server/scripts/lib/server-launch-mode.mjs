import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnvFile } from './env.mjs';
import { buildKubernetesLauncherConfig } from './kubernetes-launcher-config.mjs';
import { writeContainerState } from './container-server-files.mjs';

// Keep mode selection out of dotenv. In particular, a production context or
// credential in the shared file must never redirect VM provisioning.
export function vmEnvironment(source) {
  const env = {
    RIVET_K8S_CONTEXT: 'rivet-vm',
    RIVET_K8S_CLUSTER_PROVIDER: 'minikube',
    RIVET_K8S_NAMESPACE: 'rivet-vm',
    RIVET_K8S_RELEASE: 'rivet-vm',
    RIVET_K8S_STORAGE_BUCKET: 'rivet',
    RIVET_K8S_STORAGE_REGION: 'us-east-1',
    RIVET_KEY: source.RIVET_VM_KEY || source.RIVET_KEY,
  };
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('RIVET_VM_K8S_')) env[name.replace('RIVET_VM_', 'RIVET_')] = value;
    if (
      ['RIVET_K8S_KUBECTL_BIN', 'RIVET_K8S_HELM_BIN', 'RIVET_K8S_MINIKUBE_BIN', 'RIVET_K8S_DOCKER_BIN'].includes(name)
    )
      env[name] = value;
  }
  return {
    ...env,
    RIVET_K8S_MINIKUBE_PROFILE: env.RIVET_K8S_MINIKUBE_PROFILE || env.RIVET_K8S_CONTEXT,
    RIVET_K8S_LOCAL_MANAGED_SERVICES: 'true',
    RIVET_K8S_DEPLOYMENT_PROFILE: 'single-machine',
    RIVET_K8S_PROXY_REPLICAS: '1',
    RIVET_K8S_WEB_REPLICAS: '1',
    RIVET_K8S_EXECUTION_REPLICAS: '1',
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_REQUIRE_UI_GATE_KEY: 'true',
  };
}

export function vmProcessEnvironment(processEnv, source) {
  return {
    ...Object.fromEntries(Object.entries(processEnv).filter(([name]) => !name.startsWith('RIVET_'))),
    ...vmEnvironment(source),
    RIVET_SERVER_LAUNCH_MODE: 'vm',
  };
}

// The VM command has no reset/adopt path. Credentials must survive subsequent starts.
export function initializeServerEnvironment(root, explicitPath, createDefaults) {
  const envPath = path.resolve(root, explicitPath || '.env');
  if (explicitPath && !fs.existsSync(envPath)) throw new Error('The selected environment file does not exist.');
  if (fs.existsSync(envPath) && !fs.lstatSync(envPath).isFile())
    throw new Error('Server settings must be a regular file, not a symlink.');
  const lockPath = `${envPath}.rivet-init.lock`;
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Environment initialization is already owned by another startup. After a crashed startup, remove its .rivet-init.lock only once that process has stopped.',
      );
    throw error;
  }
  try {
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, '# Shared Rivet Server settings for VM and production.\n', { flag: 'wx', mode: 0o600 });
    }
    const source = parseEnvFile(envPath);
    if (!fs.lstatSync(envPath).isFile()) throw new Error('Server settings must be a regular file, not a symlink.');
    if (process.platform !== 'win32') fs.chmodSync(envPath, 0o600);
    const defaults = createDefaults(source);
    const missing = Object.entries(defaults).filter(([name]) => !source[name]);
    // Append to the text, but publish the complete file atomically: preserve
    // comments and unrelated settings without exposing a half-written credential.
    // This parser deliberately uses the last definition.
    if (missing.length)
      writeContainerState(
        envPath,
        fs.readFileSync(envPath, 'utf8') +
          '\n# Automatically initialized local credentials. Keep these with the retained volumes.\n' +
          missing.map(([name, value]) => `${name}=${value}`).join('\n') +
          '\n',
      );
    return { envPath, source: parseEnvFile(envPath) };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

export function loadVmEnvironment(root, explicitPath) {
  const { envPath, source } = initializeServerEnvironment(root, explicitPath, (current) => ({
    ...(!current.RIVET_KEY && !current.RIVET_VM_KEY ? { RIVET_KEY: randomBytes(32).toString('hex') } : {}),
    RIVET_VM_K8S_LOCAL_POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    RIVET_VM_K8S_STORAGE_ACCESS_KEY_ID: 'rivet',
    RIVET_VM_K8S_STORAGE_ACCESS_KEY: randomBytes(32).toString('hex'),
  }));
  const env = vmEnvironment(source);
  const config = buildKubernetesLauncherConfig(env);
  if (!['minikube', 'docker-desktop'].includes(config.localClusterProvider))
    throw new Error('The automatic VM command requires Minikube or Docker Desktop.');
  return { envPath, env, config };
}

export function productionEnvironment(env, { release, namespace, context }) {
  for (const [name, selected] of Object.entries({
    RIVET_K8S_RELEASE: release,
    RIVET_K8S_NAMESPACE: namespace,
    RIVET_K8S_CONTEXT: context,
  })) {
    if (!selected || env[name] !== selected) throw new Error(`Production selection must match ${name}.`);
  }
  if ((env.RIVET_KEY || '').length < 32) throw new Error('Production requires a Rivet key of at least 32 characters.');
  for (const name of ['RIVET_KEY', 'RIVET_K8S_STORAGE_ACCESS_KEY_ID', 'RIVET_K8S_STORAGE_ACCESS_KEY']) {
    if ((env[name] || '').startsWith('replace-')) throw new Error(`Replace the example value for ${name}.`);
  }
  for (const name of ['RIVET_K8S_PROXY_REPLICAS', 'RIVET_K8S_WEB_REPLICAS', 'RIVET_K8S_EXECUTION_REPLICAS']) {
    if (env[name] && (!/^[1-9][0-9]*$/.test(env[name]) || !Number.isSafeInteger(Number(env[name]))))
      throw new Error(`${name} must be a positive whole number.`);
  }
  if (env.RIVET_ENABLE_DEVELOPMENT_AUTH === 'true')
    throw new Error('Production cannot enable development authentication.');
  const config = buildKubernetesLauncherConfig({
    ...env,
    RIVET_K8S_DEPLOYMENT_PROFILE: 'cluster',
    RIVET_K8S_LOCAL_MANAGED_SERVICES: 'false',
    RIVET_SERVER_UI_AUTH_MODE: env.RIVET_SERVER_UI_AUTH_MODE || 'key',
    RIVET_REQUIRE_UI_GATE_KEY: env.RIVET_REQUIRE_UI_GATE_KEY || 'true',
    RIVET_K8S_AUTH_SECRET_NAME: env.RIVET_K8S_AUTH_SECRET_NAME || `${release}-auth`,
    RIVET_K8S_POSTGRES_SECRET_NAME: env.RIVET_K8S_POSTGRES_SECRET_NAME || `${release}-postgres-conn`,
    RIVET_K8S_OBJECT_STORAGE_SECRET_NAME: env.RIVET_K8S_OBJECT_STORAGE_SECRET_NAME || `${release}-object-storage`,
  });
  if (new Set(Object.values(config.secrets)).size !== 3)
    throw new Error('Each production credential Secret must have a distinct name.');
  for (const name of Object.values(config.secrets))
    if (name.length > 253 || !name.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)))
      throw new Error('Production Secret names must be valid DNS subdomains.');
  return config;
}

export async function prepareProductionSecrets(config, run) {
  // Never silently overwrite an operator's or another installation's credentials.
  const owner = `${config.namespace}/${config.release}`;
  const namespace = await run(['get', 'namespace', config.namespace, '--ignore-not-found', '-o', 'json'], {
    capture: true,
  });
  if (!namespace.stdout.trim()) {
    await run(['create', '-f', '-'], {
      capture: true,
      input: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: config.namespace } }),
    });
  }
  const resources = [
    { name: config.secrets.authName, stringData: { RIVET_KEY: config.sharedKey } },
    { name: config.secrets.postgresName, stringData: { connectionString: config.databaseConnectionString } },
    {
      name: config.secrets.objectStorageName,
      stringData: {
        accessKeyId: config.objectStorage.accessKeyId,
        secretAccessKey: config.objectStorage.secretAccessKey,
      },
    },
  ];
  const prepared = [];
  for (const { name, stringData } of resources) {
    const result = await run(['-n', config.namespace, 'get', 'secret', name, '--ignore-not-found', '-o', 'json'], {
      capture: true,
    });
    const existing = result.stdout.trim() ? JSON.parse(result.stdout) : null;
    if (existing && existing.metadata?.annotations?.['rivet.dev/server-launcher-owner'] !== owner)
      throw new Error(`Secret ${name} is not owned by this installation; refusing to overwrite it.`);
    prepared.push({
      existing,
      resource: {
        apiVersion: 'v1',
        kind: 'Secret',
        type: 'Opaque',
        metadata: {
          ...existing?.metadata,
          name,
          namespace: config.namespace,
          annotations: { ...existing?.metadata?.annotations, 'rivet.dev/server-launcher-owner': owner },
        },
        ...(existing?.immutable ? { immutable: true } : {}),
        ...(existing?.data ? { data: existing.data } : {}),
        stringData,
      },
    });
  }
  // Create is exclusive; replacement is fenced by resourceVersion. A race is a
  // conflict, never permission to overwrite a resource we did not inspect.
  for (const { existing, resource } of prepared) {
    try {
      await run([existing ? 'replace' : 'create', '-f', '-'], { capture: true, input: JSON.stringify(resource) });
    } catch (error) {
      // Admission errors can echo submitted Secret data. Do not print them.
      throw new Error(
        `Credential write for ${resource.metadata.name} failed; outcome unknown. Inspect the installation's Secret state before retrying.`,
        { cause: error },
      );
    }
  }
}
