import path from 'node:path';

const imageKeys = ['proxy', 'web', 'api', 'executor'];
const namespacePattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function requireString(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) {
    throw new Error(`[kubernetes-managed-release-gate] ${name} is required`);
  }
  return value;
}

function optionalString(env, name, fallback) {
  const value = String(env[name] ?? '').trim();
  return value || fallback;
}

function parseBoolean(env, name, fallback) {
  const value = String(env[name] ?? '').trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(value)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value)) {
    return false;
  }
  throw new Error(`[kubernetes-managed-release-gate] ${name} must be true or false`);
}

function parsePositiveInteger(env, name, fallback) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[kubernetes-managed-release-gate] ${name} must be a positive integer`);
  }
  return value;
}

function assertDnsLabel(value, name) {
  if (value.length > 63 || !namespacePattern.test(value)) {
    throw new Error(`[kubernetes-managed-release-gate] ${name} must be a DNS label of at most 63 characters`);
  }
  return value;
}

function assertInsideRoot(rootDir, candidatePath, name) {
  const resolved = path.resolve(rootDir, candidatePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[kubernetes-managed-release-gate] ${name} must remain inside the repository`);
  }
  return resolved;
}

function imageEnvName(key, suffix) {
  return `RIVET_K8S_RELEASE_GATE_${key.toUpperCase()}_IMAGE_${suffix}`;
}

function buildImages(env) {
  const images = {};
  for (const key of imageKeys) {
    const repository = requireString(env, imageEnvName(key, 'REPOSITORY'));
    const digest = requireString(env, imageEnvName(key, 'DIGEST')).toLowerCase();
    if (!digestPattern.test(digest)) {
      throw new Error(`[kubernetes-managed-release-gate] ${imageEnvName(key, 'DIGEST')} must be a sha256 OCI digest`);
    }
    images[key] = { repository, digest };
  }
  return images;
}

export function buildManagedReleaseGateConfig({
  rootDir,
  env = process.env,
  mode = 'smoke',
} = {}) {
  if (!rootDir) {
    throw new Error('[kubernetes-managed-release-gate] rootDir is required');
  }
  if (!['smoke', 'release'].includes(mode)) {
    throw new Error('[kubernetes-managed-release-gate] mode must be smoke or release');
  }

  const context = requireString(env, 'RIVET_K8S_RELEASE_GATE_CONTEXT');
  const allowedContext = requireString(env, 'RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT');
  if (context !== allowedContext) {
    throw new Error('[kubernetes-managed-release-gate] RIVET_K8S_RELEASE_GATE_CONTEXT and RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT must match exactly');
  }

  const namespace = assertDnsLabel(
    optionalString(env, 'RIVET_K8S_RELEASE_GATE_NAMESPACE', 'rivet-managed-release'),
    'RIVET_K8S_RELEASE_GATE_NAMESPACE',
  );
  const release = assertDnsLabel(
    optionalString(env, 'RIVET_K8S_RELEASE_GATE_RELEASE', 'rivet-managed-release'),
    'RIVET_K8S_RELEASE_GATE_RELEASE',
  );
  const registrySecretName = assertDnsLabel(
    optionalString(env, 'RIVET_K8S_RELEASE_GATE_REGISTRY_SECRET_NAME', 'rivet-release-gate-registry'),
    'RIVET_K8S_RELEASE_GATE_REGISTRY_SECRET_NAME',
  );

  const registry = {
    server: optionalString(env, 'RIVET_K8S_RELEASE_GATE_REGISTRY_SERVER', 'ghcr.io'),
    username: requireString(env, 'RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME'),
    password: requireString(env, 'RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD'),
    secretName: registrySecretName,
  };

  return {
    mode,
    context,
    allowedContext,
    namespace,
    release,
    images: buildImages(env),
    registry,

    artifactsDir: assertInsideRoot(
      rootDir,
      optionalString(env, 'RIVET_K8S_RELEASE_GATE_ARTIFACTS_DIR', 'artifacts/kubernetes-managed-release-gate'),
      'RIVET_K8S_RELEASE_GATE_ARTIFACTS_DIR',
    ),
    deploymentTimeoutSeconds: parsePositiveInteger(env, 'RIVET_K8S_RELEASE_GATE_DEPLOYMENT_TIMEOUT_SECONDS', 600),
    keepNamespace: parseBoolean(env, 'RIVET_K8S_RELEASE_GATE_KEEP_NAMESPACE', false),
  };
}

export function renderManagedReleaseGateValues(config) {
  return {
    fullnameOverride: config.release,
    imagePullSecrets: [{ name: config.registry.secretName }],
    images: Object.fromEntries(Object.entries(config.images).map(([key, image]) => [key, {
      repository: image.repository,
      digest: image.digest,
      pullPolicy: 'Always',
    }])),
    postgres: {
      host: 'release-gate-postgres',
      port: 5432,
      database: 'rivet',
      username: 'rivet',
      passwordSecretName: 'rivet-release-gate-postgres',
      passwordSecretKey: 'password',
    },
    objectStorage: {
      endpoint: 'http://release-gate-minio:9000',
      bucket: 'rivet-release-gate',
      accessKeySecretName: 'rivet-release-gate-object-storage',
      accessKeySecretKey: 'accessKeyId',
      secretKeySecretName: 'rivet-release-gate-object-storage',
      secretKeySecretKey: 'secretAccessKey',
    },
    appSettings: {
      encryptionKeySecretName: 'rivet-release-gate-settings',
      encryptionKeySecretKey: 'encryptionKey',
    },
    auth: {
      keySecretName: 'rivet-release-gate-auth',
      keySecretKey: 'RIVET_KEY',
    },
  };
}

export function imageReference(image) {
  return `${image.repository}@${image.digest}`;
}