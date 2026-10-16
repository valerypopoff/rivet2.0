import { createHash } from 'node:crypto';

export function localStorageFingerprint(config) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        endpoint: config.objectStorage.endpoint,
        bucket: config.objectStorage.bucket,
        region: config.objectStorage.region,
        prefix: config.objectStorage.prefix,
        forcePathStyle: config.objectStorage.forcePathStyle,
      }),
    )
    .digest('hex');
}

function readEnv(env, name) {
  const value = String(env[name] ?? '').trim();
  return value ? value : undefined;
}

function requireEnv(env, name, launcherName) {
  const value = readEnv(env, name);
  if (!value) {
    throw new Error(`[${launcherName}] Missing required environment variable: ${name}`);
  }

  return value;
}

function parseBoolean(value, fallback) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseManagedStorageUrl(rawUrl, explicitBucket) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid storage URL "${rawUrl}"`);
  }

  const pathSegments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const hostParts = url.hostname.split('.').filter(Boolean);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Storage URL must use HTTP(S) without credentials, query, or fragment');
  }

  if (pathSegments.length > 0) {
    if (pathSegments.length !== 1 || (explicitBucket && pathSegments[0] !== explicitBucket)) {
      throw new Error('Storage URL path must identify only the configured bucket');
    }
    return {
      bucket: pathSegments[0],
      endpoint: url.origin,
      forcePathStyle: true,
    };
  }

  if (hostParts.length >= 2) {
    const bucket = explicitBucket ?? hostParts[0];
    if (!url.hostname.startsWith(`${bucket}.`)) {
      throw new Error(`Storage URL host does not start with the configured bucket "${bucket}"`);
    }

    return {
      bucket,
      endpoint: `${url.protocol}//${url.host.slice(bucket.length + 1)}`,
      forcePathStyle: false,
    };
  }

  throw new Error(`Storage URL "${rawUrl}" does not include a bucket name`);
}

function parseImageConfig(env, prefix, defaultRepository, defaultTag) {
  return {
    repository: readEnv(env, `${prefix}_REPOSITORY`) ?? defaultRepository,
    tag: readEnv(env, `${prefix}_TAG`) ?? defaultTag,
  };
}

/**
 * Local Kubernetes nodes do not reliably replace an already-imported image
 * when the tag stays the same. Development builds therefore use a fresh tag;
 * a later `up` command reuses the tag recorded by the preceding build.
 */
export function resolveKubernetesLauncherImageTag({ action, explicitImageTag, persistedImageTag, generatedImageTag }) {
  if (explicitImageTag) {
    return explicitImageTag;
  }

  if (action === 'up' && persistedImageTag) {
    return persistedImageTag;
  }

  if (['build', 'dev', 'recreate'].includes(action)) {
    return generatedImageTag;
  }

  return 'dev';
}

function inferLocalClusterProvider(context, explicitProvider) {
  const normalizedExplicitProvider = String(explicitProvider ?? '')
    .trim()
    .toLowerCase();
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

function yamlString(value) {
  return JSON.stringify(String(value));
}

function yamlBoolean(value) {
  return value ? 'true' : 'false';
}

export function buildKubernetesLauncherConfig(env, { singleMachine = false } = {}) {
  const launcherName = 'dev-kubernetes';
  const deploymentProfile = singleMachine
    ? 'single-machine'
    : readEnv(env, 'RIVET_K8S_DEPLOYMENT_PROFILE') ?? 'cluster';
  if (!['cluster', 'single-machine'].includes(deploymentProfile))
    throw new Error('RIVET_K8S_DEPLOYMENT_PROFILE must be cluster or single-machine.');
  const localManaged = parseBoolean(readEnv(env, 'RIVET_K8S_LOCAL_MANAGED_SERVICES'), false);
  const namespace = readEnv(env, 'RIVET_K8S_NAMESPACE') ?? (localManaged ? 'rivet-restore-local' : 'rivet-local');
  const release = readEnv(env, 'RIVET_K8S_RELEASE') ?? 'rivet-local';
  for (const [name, value] of [
    ['namespace', namespace],
    ['release', release],
  ]) {
    if (localManaged && (!/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(value) || value.length > 40)) {
      throw new Error(`[${launcherName}] ${name} must be a lowercase DNS label of 1-40 characters.`);
    }
  }
  const storageUrl = readEnv(env, 'RIVET_K8S_STORAGE_URL');
  const explicitBucket = readEnv(env, 'RIVET_K8S_STORAGE_BUCKET');
  const parsedStorageUrl = storageUrl ? parseManagedStorageUrl(storageUrl, explicitBucket) : null;
  const imageTag = readEnv(env, 'RIVET_K8S_IMAGE_TAG') ?? 'dev';
  const context = readEnv(env, 'RIVET_K8S_CONTEXT') ?? 'docker-desktop';
  const localClusterProvider = inferLocalClusterProvider(context, readEnv(env, 'RIVET_K8S_CLUSTER_PROVIDER'));
  const clusterDomain = readEnv(env, 'RIVET_K8S_CLUSTER_DOMAIN') ?? 'cluster.local';
  const localServices = localManaged
    ? {
        postgresName: `${release}-postgres`,
        minioName: `${release}-minio`,
        database: readEnv(env, 'RIVET_K8S_LOCAL_POSTGRES_DATABASE') ?? 'rivet',
        username: readEnv(env, 'RIVET_K8S_LOCAL_POSTGRES_USER') ?? 'rivet',
        password: requireEnv(env, 'RIVET_K8S_LOCAL_POSTGRES_PASSWORD', launcherName),
        postgresSize: readEnv(env, 'RIVET_K8S_LOCAL_POSTGRES_SIZE') ?? '8Gi',
        minioSize: readEnv(env, 'RIVET_K8S_LOCAL_MINIO_SIZE') ?? '16Gi',
        storageClassName: readEnv(env, 'RIVET_K8S_LOCAL_STORAGE_CLASS') ?? '',
      }
    : null;
  let localConnectionString;
  let localEndpoint;
  if (localServices) {
    if (
      ![...(singleMachine ? ['k3s'] : []), 'minikube', 'docker-desktop'].includes(localClusterProvider) ||
      (localClusterProvider === 'docker-desktop' && context !== 'docker-desktop')
    ) {
      throw new Error(
        'Local managed services require Docker Desktop or a Minikube profile; refusing a remote context.',
      );
    }
    if (localClusterProvider === 'minikube' && (readEnv(env, 'RIVET_K8S_MINIKUBE_PROFILE') ?? context) !== context) {
      throw new Error('Local managed services require matching Minikube profile and Kubernetes context.');
    }
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(clusterDomain)) throw new Error('Invalid local cluster DNS domain.');
    for (const value of [localServices.database, localServices.username]) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
        throw new Error('Local PostgreSQL database/user must be lowercase identifiers.');
    }
    for (const value of [localServices.postgresSize, localServices.minioSize]) {
      if (!/^[1-9][0-9]*(Mi|Gi|Ti)$/.test(value))
        throw new Error('Local volume sizes must be positive Mi/Gi/Ti quantities.');
    }
    localConnectionString = `postgresql://${encodeURIComponent(localServices.username)}:${encodeURIComponent(localServices.password)}@${localServices.postgresName}.${namespace}.svc.${clusterDomain}:5432/${localServices.database}?sslmode=disable`;
    localEndpoint = `http://${localServices.minioName}.${namespace}.svc.${clusterDomain}:9000`;
    const suppliedDatabase = readEnv(env, 'RIVET_K8S_DATABASE_CONNECTION_STRING');
    const suppliedEndpoint = readEnv(env, 'RIVET_K8S_STORAGE_ENDPOINT') ?? parsedStorageUrl?.endpoint;
    if (
      (suppliedDatabase && suppliedDatabase !== localConnectionString) ||
      (suppliedEndpoint && suppliedEndpoint !== localEndpoint)
    ) {
      throw new Error(
        'Local managed services cannot use external database/object-storage URLs. Remove conflicting .env values.',
      );
    }
    if (
      (readEnv(env, 'RIVET_K8S_DATABASE_SSL_MODE') && readEnv(env, 'RIVET_K8S_DATABASE_SSL_MODE') !== 'disable') ||
      !parseBoolean(readEnv(env, 'RIVET_K8S_STORAGE_FORCE_PATH_STYLE'), true)
    ) {
      throw new Error('Local PostgreSQL uses SSL mode disable; local MinIO requires path-style addressing.');
    }
    if ((readEnv(env, 'RIVET_SERVER_UI_AUTH_MODE') ?? 'key') !== 'key') {
      throw new Error('The local restore rehearsal requires key UI authentication.');
    }
    if (
      requireEnv(env, 'RIVET_KEY', launcherName).length < 32 ||
      requireEnv(env, 'RIVET_K8S_STORAGE_ACCESS_KEY_ID', launcherName).length < 3 ||
      requireEnv(env, 'RIVET_K8S_STORAGE_ACCESS_KEY', launcherName).length < 8
    ) {
      throw new Error(
        'Local rehearsal requires a 32+ character Rivet key and valid MinIO credentials (3+ / 8+ characters).',
      );
    }
    const secretNames = [
      'RIVET_K8S_AUTH_SECRET_NAME',
      'RIVET_K8S_POSTGRES_SECRET_NAME',
      'RIVET_K8S_OBJECT_STORAGE_SECRET_NAME',
    ].map((name, index) => readEnv(env, name) ?? ['rivet-auth', 'rivet-postgres-conn', 'rivet-object-storage'][index]);
    if (
      new Set(secretNames).size !== 3 ||
      secretNames.some((name) => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name))
    ) {
      throw new Error('Local authentication, PostgreSQL and object-storage secrets need distinct valid names.');
    }
  }

  const config = {
    singleMachine,
    deploymentProfile,
    release,
    namespace,
    localServices,
    context,
    localClusterProvider,
    minikubeProfile:
      localClusterProvider === 'minikube' ? readEnv(env, 'RIVET_K8S_MINIKUBE_PROFILE') ?? context : undefined,
    clusterDomain,
    localPort: parsePositiveInt(readEnv(env, 'RIVET_K8S_PROXY_PORT') ?? readEnv(env, 'RIVET_PORT'), 8080),
    loadLocalImages: parseBoolean(
      readEnv(env, 'RIVET_K8S_LOAD_LOCAL_IMAGES'),
      localClusterProvider === 'docker-desktop' || localClusterProvider === 'minikube',
    ),
    replicas: {
      proxy: parsePositiveInt(readEnv(env, 'RIVET_K8S_PROXY_REPLICAS'), deploymentProfile === 'single-machine' ? 1 : 2),
      web: parsePositiveInt(readEnv(env, 'RIVET_K8S_WEB_REPLICAS'), 1),
      execution: parsePositiveInt(
        readEnv(env, 'RIVET_K8S_EXECUTION_REPLICAS'),
        deploymentProfile === 'single-machine' ? 1 : 2,
      ),
    },
    images: {
      proxy: parseImageConfig(env, 'RIVET_K8S_PROXY_IMAGE', 'rivet-local/proxy', imageTag),
      web: parseImageConfig(env, 'RIVET_K8S_WEB_IMAGE', 'rivet-local/web', imageTag),
      api: parseImageConfig(env, 'RIVET_K8S_API_IMAGE', 'rivet-local/api', imageTag),
      executor: parseImageConfig(env, 'RIVET_K8S_EXECUTOR_IMAGE', 'rivet-local/executor', imageTag),
    },
    secrets: {
      authName: readEnv(env, 'RIVET_K8S_AUTH_SECRET_NAME') ?? 'rivet-auth',
      postgresName: readEnv(env, 'RIVET_K8S_POSTGRES_SECRET_NAME') ?? 'rivet-postgres-conn',
      objectStorageName: readEnv(env, 'RIVET_K8S_OBJECT_STORAGE_SECRET_NAME') ?? 'rivet-object-storage',
    },
    sharedKey: requireEnv(env, 'RIVET_KEY', launcherName),
    databaseConnectionString:
      localConnectionString ?? requireEnv(env, 'RIVET_K8S_DATABASE_CONNECTION_STRING', launcherName),
    databaseSslMode: readEnv(env, 'RIVET_K8S_DATABASE_SSL_MODE') ?? (localManaged ? 'disable' : 'require'),
    objectStorage: {
      bucket: explicitBucket ?? parsedStorageUrl?.bucket ?? requireEnv(env, 'RIVET_K8S_STORAGE_BUCKET', launcherName),
      region: requireEnv(env, 'RIVET_K8S_STORAGE_REGION', launcherName),
      endpoint: localEndpoint ?? readEnv(env, 'RIVET_K8S_STORAGE_ENDPOINT') ?? parsedStorageUrl?.endpoint ?? '',
      accessKeyId: requireEnv(env, 'RIVET_K8S_STORAGE_ACCESS_KEY_ID', launcherName),
      secretAccessKey: requireEnv(env, 'RIVET_K8S_STORAGE_ACCESS_KEY', launcherName),
      prefix: (readEnv(env, 'RIVET_K8S_STORAGE_PREFIX') ?? 'workflows/').replace(/^\/+/, ''),
      forcePathStyle: parseBoolean(
        readEnv(env, 'RIVET_K8S_STORAGE_FORCE_PATH_STYLE'),
        localManaged || (parsedStorageUrl?.forcePathStyle ?? false),
      ),
    },
    routeConfig: {
      publishedBasePath: readEnv(env, 'RIVET_PUBLISHED_WORKFLOWS_BASE_PATH') ?? '/workflows',
      latestBasePath: readEnv(env, 'RIVET_LATEST_WORKFLOWS_BASE_PATH') ?? '/workflows-latest',
      webAppsBasePath:
        readEnv(env, 'RIVET_PUBLISHED_APPS_BASE_PATH') ?? readEnv(env, 'RIVET_WEB_APPS_BASE_PATH') ?? '/apps',
      latestWebAppsBasePath:
        readEnv(env, 'RIVET_LATEST_APPS_BASE_PATH') ??
        readEnv(env, 'RIVET_LATEST_WEB_APPS_BASE_PATH') ??
        '/apps-latest',
      proxyResolver: readEnv(env, 'RIVET_PROXY_RESOLVER') ?? 'kube-dns.kube-system.svc.cluster.local',
      enableLatestRemoteDebugger: parseBoolean(readEnv(env, 'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER'), true),
      corsAllowedOrigins: readEnv(env, 'RIVET_CORS_ALLOWED_ORIGINS') ?? '',
      serverUiAuthMode:
        readEnv(env, 'RIVET_SERVER_UI_AUTH_MODE') ??
        (localManaged || parseBoolean(readEnv(env, 'RIVET_REQUIRE_UI_GATE_KEY'), false) ? 'key' : 'none'),
      requireUiGateKey: localManaged || parseBoolean(readEnv(env, 'RIVET_REQUIRE_UI_GATE_KEY'), false),
      trustIncomingForwardedHeaders: parseBoolean(readEnv(env, 'RIVET_TRUST_INCOMING_FORWARDED_HEADERS'), false),
      trustedForwardingProxies: readEnv(env, 'RIVET_TRUSTED_FORWARDING_PROXIES') ?? '',
      enableDevelopmentAuth: readEnv(env, 'RIVET_ENABLE_DEVELOPMENT_AUTH') === 'true',
      developmentAuthClients: readEnv(env, 'RIVET_DEVELOPMENT_AUTH_CLIENTS') ?? '',
    },
  };
  if (deploymentProfile === 'single-machine' && Object.values(config.replicas).some((count) => count > 1)) {
    throw new Error('The single-machine profile requires exactly one replica per application role.');
  }
  return config;
}

export function renderKubernetesLauncherValuesYaml(config) {
  return [
    `deploymentProfile: ${yamlString(config.deploymentProfile ?? 'cluster')}`,
    ...(config.deploymentProfile === 'single-machine'
      ? [
          'gateway:',
          '  mode: embedded',
          'service:',
          '  api:',
          '    targetPort: 8081',
          '  execution:',
          '    targetPort: 8082',
          'hostedEvaluations:',
          '  enabled: true',
          '  workerConcurrency: 1',
        ]
      : []),
    'legacyRestore:',
    '  enabled: true',
    ...(config.localServices?.storageClassName
      ? [`  storageClassName: ${yamlString(config.localServices.storageClassName)}`]
      : []),
    'images:',
    '  proxy:',
    `    repository: ${yamlString(config.images.proxy.repository)}`,
    `    tag: ${yamlString(config.images.proxy.tag)}`,
    '  web:',
    `    repository: ${yamlString(config.images.web.repository)}`,
    `    tag: ${yamlString(config.images.web.tag)}`,
    '  api:',
    `    repository: ${yamlString(config.images.api.repository)}`,
    `    tag: ${yamlString(config.images.api.tag)}`,
    '  executor:',
    `    repository: ${yamlString(config.images.executor.repository)}`,
    `    tag: ${yamlString(config.images.executor.tag)}`,
    `clusterDomain: ${yamlString(config.clusterDomain)}`,
    'replicaCount:',
    `  proxy: ${config.replicas.proxy}`,
    `  web: ${config.replicas.web}`,
    '  backend: 1',
    `  execution: ${config.replicas.execution}`,
    'autoscaling:',
    '  proxy:',
    '    enabled: false',
    '  web:',
    '    enabled: false',
    '  backend:',
    '    enabled: false',
    '  execution:',
    '    enabled: false',
    'vault:',
    '  enabled: false',
    'auth:',
    `  keySecretName: ${yamlString(config.secrets.authName)}`,
    'appSettings:',
    '  backend: postgres',
    'workflowStorage:',
    '  backend: managed',
    'runtimeLibraries:',
    '  backend: managed',
    'postgres:',
    '  mode: managed',
    `  connectionStringSecretName: ${yamlString(config.secrets.postgresName)}`,
    '  connectionStringSecretKey: "connectionString"',
    `  sslMode: ${yamlString(config.databaseSslMode)}`,
    // Keep the advertised capacity consistent with the local server's configuration.
    ...(config.localServices ? ['  maxConnections: 200'] : []),
    'objectStorage:',
    `  endpoint: ${yamlString(config.objectStorage.endpoint)}`,
    `  bucket: ${yamlString(config.objectStorage.bucket)}`,
    `  region: ${yamlString(config.objectStorage.region)}`,
    `  prefix: ${yamlString(config.objectStorage.prefix)}`,
    `  accessKeySecretName: ${yamlString(config.secrets.objectStorageName)}`,
    `  secretKeySecretName: ${yamlString(config.secrets.objectStorageName)}`,
    `  forcePathStyle: ${yamlBoolean(config.objectStorage.forcePathStyle)}`,
    'env:',
    `  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH: ${yamlString(config.routeConfig.publishedBasePath)}`,
    `  RIVET_LATEST_WORKFLOWS_BASE_PATH: ${yamlString(config.routeConfig.latestBasePath)}`,
    `  RIVET_PUBLISHED_APPS_BASE_PATH: ${yamlString(config.routeConfig.webAppsBasePath)}`,
    `  RIVET_LATEST_APPS_BASE_PATH: ${yamlString(config.routeConfig.latestWebAppsBasePath)}`,
    `  RIVET_WEB_APPS_BASE_PATH: ${yamlString(config.routeConfig.webAppsBasePath)}`,
    `  RIVET_LATEST_WEB_APPS_BASE_PATH: ${yamlString(config.routeConfig.latestWebAppsBasePath)}`,
    `  RIVET_PROXY_RESOLVER: ${yamlString(config.routeConfig.proxyResolver)}`,
    `  RIVET_ENABLE_LATEST_REMOTE_DEBUGGER: ${yamlString(String(config.routeConfig.enableLatestRemoteDebugger))}`,
    `  RIVET_CORS_ALLOWED_ORIGINS: ${yamlString(config.routeConfig.corsAllowedOrigins)}`,
    `  RIVET_SERVER_UI_AUTH_MODE: ${yamlString(config.routeConfig.serverUiAuthMode)}`,
    `  RIVET_REQUIRE_UI_GATE_KEY: ${yamlString(String(config.routeConfig.requireUiGateKey))}`,
    `  RIVET_TRUST_INCOMING_FORWARDED_HEADERS: ${yamlString(String(config.routeConfig.trustIncomingForwardedHeaders))}`,
    `  RIVET_TRUSTED_FORWARDING_PROXIES: ${yamlString(config.routeConfig.trustedForwardingProxies)}`,
    `  RIVET_ENABLE_DEVELOPMENT_AUTH: ${yamlString(String(config.routeConfig.enableDevelopmentAuth))}`,
    `  RIVET_DEVELOPMENT_AUTH_CLIENTS: ${yamlString(config.routeConfig.developmentAuthClients)}`,
    '',
  ].join('\n');
}

export function renderKubernetesLauncherSecretManifest(config) {
  const ownership = config.localServices
    ? ['  labels:', `    rivet.dev/local-launcher-owner: ${yamlString(config.release)}`]
    : [];
  return [
    'apiVersion: v1',
    'kind: Namespace',
    'metadata:',
    `  name: ${config.namespace}`,
    '---',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${config.secrets.authName}`,
    `  namespace: ${config.namespace}`,
    ...ownership,
    'type: Opaque',
    'stringData:',
    `  RIVET_KEY: ${yamlString(config.sharedKey)}`,
    '---',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${config.secrets.postgresName}`,
    `  namespace: ${config.namespace}`,
    ...ownership,
    'type: Opaque',
    'stringData:',
    `  connectionString: ${yamlString(config.databaseConnectionString)}`,
    ...(config.localServices
      ? [
          `  password: ${yamlString(config.localServices.password)}`,
          `  username: ${yamlString(config.localServices.username)}`,
          `  database: ${yamlString(config.localServices.database)}`,
        ]
      : []),
    '---',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${config.secrets.objectStorageName}`,
    `  namespace: ${config.namespace}`,
    ...ownership,
    'type: Opaque',
    'stringData:',
    `  accessKeyId: ${yamlString(config.objectStorage.accessKeyId)}`,
    `  secretAccessKey: ${yamlString(config.objectStorage.secretAccessKey)}`,
    ...(config.localServices ? [`  localStorageFingerprint: ${yamlString(localStorageFingerprint(config))}`] : []),
    '',
  ].join('\n');
}

export function buildImageRef(image) {
  return `${image.repository}:${image.tag}`;
}
