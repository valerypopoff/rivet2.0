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
  const normalized = String(value ?? '').trim().toLowerCase();
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

function parseManagedStorageUrl(rawUrl) {
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

  if (pathSegments.length > 0) {
    return {
      bucket: pathSegments[0],
      endpoint: url.origin,
      region: hostParts[0] === 's3' && hostParts[1] ? hostParts[1] : null,
      forcePathStyle: true,
    };
  }

  if (hostParts.length >= 2) {
    const bucket = hostParts[0];
    let region = null;
    let endpointHost = hostParts.slice(1).join('.');

    if (url.hostname.endsWith('.digitaloceanspaces.com') && hostParts.length >= 3) {
      region = hostParts[1] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    } else if (hostParts[1] === 's3') {
      region = hostParts[2] ?? null;
      endpointHost = hostParts.slice(1).join('.');
    }

    return {
      bucket,
      endpoint: `${url.protocol}//${endpointHost}`,
      region,
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

function yamlString(value) {
  return JSON.stringify(String(value));
}

function yamlBoolean(value) {
  return value ? 'true' : 'false';
}

export function buildKubernetesLauncherConfig(env) {
  const launcherName = 'dev-kubernetes';
  const storageMode = readEnv(env, 'RIVET_STORAGE_MODE') ?? 'filesystem';
  if (storageMode !== 'managed') {
    throw new Error(`[${launcherName}] RIVET_STORAGE_MODE must be "managed" for local Kubernetes rehearsal.`);
  }

  const databaseMode = readEnv(env, 'RIVET_DATABASE_MODE') ?? 'managed';
  if (databaseMode !== 'managed') {
    throw new Error(
      `[${launcherName}] RIVET_DATABASE_MODE must be "managed" for local Kubernetes rehearsal. ` +
      'Use external managed Postgres instead of the local-docker dependency mode.',
    );
  }

  const storageUrl = readEnv(env, 'RIVET_STORAGE_URL');
  const parsedStorageUrl = storageUrl ? parseManagedStorageUrl(storageUrl) : null;
  const imageTag = readEnv(env, 'RIVET_K8S_IMAGE_TAG') ?? 'dev';
  const context = readEnv(env, 'RIVET_K8S_CONTEXT') ?? 'docker-desktop';
  const localClusterProvider = inferLocalClusterProvider(context, readEnv(env, 'RIVET_K8S_CLUSTER_PROVIDER'));

  return {
    release: readEnv(env, 'RIVET_K8S_RELEASE') ?? 'rivet-local',
    namespace: readEnv(env, 'RIVET_K8S_NAMESPACE') ?? 'rivet-local',
    context,
    localClusterProvider,
    minikubeProfile: localClusterProvider === 'minikube'
      ? readEnv(env, 'RIVET_K8S_MINIKUBE_PROFILE') ?? context
      : undefined,
    clusterDomain: readEnv(env, 'RIVET_K8S_CLUSTER_DOMAIN') ?? 'cluster.local',
    localPort: parsePositiveInt(readEnv(env, 'RIVET_K8S_PROXY_PORT') ?? readEnv(env, 'RIVET_PORT'), 8080),
    loadLocalImages: parseBoolean(
      readEnv(env, 'RIVET_K8S_LOAD_LOCAL_IMAGES'),
      localClusterProvider === 'docker-desktop' || localClusterProvider === 'minikube',
    ),
    replicas: {
      proxy: parsePositiveInt(readEnv(env, 'RIVET_K8S_PROXY_REPLICAS'), 2),
      web: parsePositiveInt(readEnv(env, 'RIVET_K8S_WEB_REPLICAS'), 1),
      execution: parsePositiveInt(readEnv(env, 'RIVET_K8S_EXECUTION_REPLICAS'), 2),
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
    databaseConnectionString: requireEnv(env, 'RIVET_DATABASE_CONNECTION_STRING', launcherName),
    databaseSslMode: readEnv(env, 'RIVET_DATABASE_SSL_MODE') ?? 'require',
    objectStorage: {
      bucket: readEnv(env, 'RIVET_STORAGE_BUCKET') ?? parsedStorageUrl?.bucket ?? requireEnv(env, 'RIVET_STORAGE_BUCKET', launcherName),
      region: readEnv(env, 'RIVET_STORAGE_REGION') ?? parsedStorageUrl?.region ?? 'us-east-1',
      endpoint: readEnv(env, 'RIVET_STORAGE_ENDPOINT') ?? parsedStorageUrl?.endpoint ?? '',
      accessKeyId: requireEnv(env, 'RIVET_STORAGE_ACCESS_KEY_ID', launcherName),
      secretAccessKey: requireEnv(env, 'RIVET_STORAGE_ACCESS_KEY', launcherName),
      prefix: (readEnv(env, 'RIVET_STORAGE_PREFIX') ?? 'workflows/').replace(/^\/+/, ''),
      forcePathStyle: parseBoolean(
        readEnv(env, 'RIVET_STORAGE_FORCE_PATH_STYLE'),
        parsedStorageUrl?.forcePathStyle ?? false,
      ),
    },
    routeConfig: {
      publishedBasePath: readEnv(env, 'RIVET_PUBLISHED_WORKFLOWS_BASE_PATH') ?? '/workflows',
      latestBasePath: readEnv(env, 'RIVET_LATEST_WORKFLOWS_BASE_PATH') ?? '/workflows-latest',
      webAppsBasePath: readEnv(env, 'RIVET_PUBLISHED_APPS_BASE_PATH') ?? readEnv(env, 'RIVET_WEB_APPS_BASE_PATH') ?? '/apps',
      latestWebAppsBasePath: readEnv(env, 'RIVET_LATEST_APPS_BASE_PATH') ?? readEnv(env, 'RIVET_LATEST_WEB_APPS_BASE_PATH') ?? '/apps-latest',
      proxyResolver: readEnv(env, 'RIVET_PROXY_RESOLVER') ?? 'kube-dns.kube-system.svc.cluster.local',
      enableLatestRemoteDebugger: parseBoolean(readEnv(env, 'RIVET_ENABLE_LATEST_REMOTE_DEBUGGER'), true),
      corsAllowedOrigins: readEnv(env, 'RIVET_CORS_ALLOWED_ORIGINS') ?? '',
      requireWorkflowKey: parseBoolean(readEnv(env, 'RIVET_REQUIRE_WORKFLOW_KEY'), false),
      requireUiGateKey: parseBoolean(readEnv(env, 'RIVET_REQUIRE_UI_GATE_KEY'), false),
      trustIncomingForwardedHeaders: parseBoolean(readEnv(env, 'RIVET_TRUST_INCOMING_FORWARDED_HEADERS'), false),
      webAppsAuthMode: readEnv(env, 'RIVET_WEB_APPS_AUTH_MODE') ?? 'ui-gate',
    },
  };
}

export function renderKubernetesLauncherValuesYaml(config) {
  return [
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
    'workflowStorage:',
    '  backend: managed',
    'runtimeLibraries:',
    '  backend: managed',
    'postgres:',
    '  mode: managed',
    `  connectionStringSecretName: ${yamlString(config.secrets.postgresName)}`,
    '  connectionStringSecretKey: "connectionString"',
    `  sslMode: ${yamlString(config.databaseSslMode)}`,
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
    `  RIVET_REQUIRE_WORKFLOW_KEY: ${yamlString(String(config.routeConfig.requireWorkflowKey))}`,
    `  RIVET_REQUIRE_UI_GATE_KEY: ${yamlString(String(config.routeConfig.requireUiGateKey))}`,
    `  RIVET_TRUST_INCOMING_FORWARDED_HEADERS: ${yamlString(String(config.routeConfig.trustIncomingForwardedHeaders))}`,
    `  RIVET_WEB_APPS_AUTH_MODE: ${yamlString(config.routeConfig.webAppsAuthMode)}`,
    '',
  ].join('\n');
}

export function renderKubernetesLauncherSecretManifest(config) {
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
    'type: Opaque',
    'stringData:',
    `  RIVET_KEY: ${yamlString(config.sharedKey)}`,
    '---',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${config.secrets.postgresName}`,
    `  namespace: ${config.namespace}`,
    'type: Opaque',
    'stringData:',
    `  connectionString: ${yamlString(config.databaseConnectionString)}`,
    '---',
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${config.secrets.objectStorageName}`,
    `  namespace: ${config.namespace}`,
    'type: Opaque',
    'stringData:',
    `  accessKeyId: ${yamlString(config.objectStorage.accessKeyId)}`,
    `  secretAccessKey: ${yamlString(config.objectStorage.secretAccessKey)}`,
    '',
  ].join('\n');
}

export function buildImageRef(image) {
  return `${image.repository}:${image.tag}`;
}
