import fs from "node:fs";
import path from "node:path";
const imageKeys = ["proxy", "web", "api", "executor"];
const dnsLabelPattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const stagingNamespacePattern = /^rivet-staging-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
function requireString(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value)
    throw new Error(`[kubernetes-managed-provider-gate] ${name} is required`);
  return value;
}
function optionalString(env, name, fallback) {
  return String(env[name] ?? "").trim() || fallback;
}
function parsePositiveInteger(env, name, fallback) {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must be a positive integer`,
    );
  }
  return value;
}
function assertDnsLabel(value, name) {
  if (value.length > 63 || !dnsLabelPattern.test(value)) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must be a DNS label of at most 63 characters`,
    );
  }
  return value;
}
function assertPathInside(directory, candidate, name) {
  if (!candidate) {
    throw new Error(`[kubernetes-managed-provider-gate] ${name} is required`);
  }
  const resolved = path.resolve(directory, candidate);
  const relative = path.relative(directory, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must remain inside ${directory}`,
    );
  }
  return resolved;
}
function assertExistingRegularFile(filePath, name) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must identify a readable regular file`,
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must identify a readable non-symlink regular file`,
    );
  }
  return filePath;
}
function assertExistingRegularFileInside(directory, candidate, name) {
  const filePath = assertExistingRegularFile(
    assertPathInside(directory, candidate, name),
    name,
  );
  const resolvedDirectory = fs.realpathSync(directory);
  const resolvedFilePath = fs.realpathSync(filePath);
  return assertPathInside(resolvedDirectory, resolvedFilePath, name);
}
function assertArtifactPath(rootDir, candidate) {
  const resolved = path.resolve(rootDir, candidate);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "[kubernetes-managed-provider-gate] RIVET_K8S_PROVIDER_GATE_ARTIFACTS_DIR must remain inside the repository",
    );
  }
  return resolved;
}
function parseJsonFile(filePath, name) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `[kubernetes-managed-provider-gate] could not read ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function assertObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must be an object`,
    );
  }
  return value;
}
function assertSameOriginPath(value, name) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("://")
  ) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name} must be an absolute path on the configured staging host`,
    );
  }
  return value;
}
function normalizeProbe(
  value,
  name,
  { requireBody = false, requireContains = false } = {},
) {
  const probe = assertObject(value, name);
  const pathValue = assertSameOriginPath(probe.path, `${name}.path`);
  const method = String(probe.method ?? "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name}.method must be GET or POST`,
    );
  }
  if (requireBody && (probe.body === undefined || probe.body === null)) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name}.body is required`,
    );
  }
  const expectedStatus = probe.expectedStatus ?? 200;
  if (
    !Number.isInteger(expectedStatus) ||
    expectedStatus < 200 ||
    expectedStatus > 299
  ) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name}.expectedStatus must be a 2xx status`,
    );
  }
  const contains = probe.contains;
  if (contains !== undefined && (typeof contains !== "string" || !contains)) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name}.contains must be a non-empty string when provided`,
    );
  }
  if (requireContains && !contains) {
    throw new Error(
      `[kubernetes-managed-provider-gate] ${name}.contains is required`,
    );
  }
  return {
    path: pathValue,
    method,
    body: probe.body,
    expectedStatus,
    contains,
  };
}
function buildImages(env) {
  const images = {};
  for (const key of imageKeys) {
    const upperKey = key.toUpperCase();
    const repository = requireString(
      env,
      `RIVET_K8S_PROVIDER_GATE_${upperKey}_IMAGE_REPOSITORY`,
    );
    const digest = requireString(
      env,
      `RIVET_K8S_PROVIDER_GATE_${upperKey}_IMAGE_DIGEST`,
    ).toLowerCase();
    if (!digestPattern.test(digest)) {
      throw new Error(
        `[kubernetes-managed-provider-gate] RIVET_K8S_PROVIDER_GATE_${upperKey}_IMAGE_DIGEST must be a sha256 OCI digest`,
      );
    }
    images[key] = { repository, digest };
  }
  return images;
}
export function buildManagedProviderGateConfig({
  rootDir,
  env = process.env,
} = {}) {
  if (!rootDir)
    throw new Error("[kubernetes-managed-provider-gate] rootDir is required");
  if (String(env.RIVET_K8S_PROVIDER_GATE_CONFIRM ?? "") !== "deploy-staging") {
    throw new Error(
      "[kubernetes-managed-provider-gate] RIVET_K8S_PROVIDER_GATE_CONFIRM must equal deploy-staging",
    );
  }
  const context = requireString(env, "RIVET_K8S_PROVIDER_GATE_CONTEXT");
  const allowedContext = requireString(
    env,
    "RIVET_K8S_PROVIDER_GATE_ALLOW_CONTEXT",
  );
  if (context !== allowedContext) {
    throw new Error(
      "[kubernetes-managed-provider-gate] RIVET_K8S_PROVIDER_GATE_CONTEXT and RIVET_K8S_PROVIDER_GATE_ALLOW_CONTEXT must match exactly",
    );
  }
  const configFile = path.resolve(
    requireString(env, "RIVET_K8S_PROVIDER_GATE_CONFIG_FILE"),
  );
  const configDirectory = path.dirname(configFile);
  const rawConfig = assertObject(
    parseJsonFile(configFile, "RIVET_K8S_PROVIDER_GATE_CONFIG_FILE"),
    "provider gate config",
  );
  const namespace = assertDnsLabel(
    String(rawConfig.namespace ?? ""),
    "provider gate namespace",
  );
  if (!stagingNamespacePattern.test(namespace)) {
    throw new Error(
      "[kubernetes-managed-provider-gate] provider gate namespace must start with rivet-staging-",
    );
  }
  const release = assertDnsLabel(
    String(rawConfig.release ?? ""),
    "provider gate release",
  );
  let baseUrl;
  try {
    baseUrl = new URL(String(rawConfig.baseUrl ?? ""));
  } catch {
    throw new Error(
      "[kubernetes-managed-provider-gate] provider gate baseUrl must be a valid HTTPS URL",
    );
  }
  if (
    baseUrl.protocol !== "https:" ||
    !baseUrl.hostname ||
    ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname)
  ) {
    throw new Error(
      "[kubernetes-managed-provider-gate] provider gate baseUrl must be a non-local HTTPS URL",
    );
  }
  if (
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.username ||
    baseUrl.password
  ) {
    throw new Error(
      "[kubernetes-managed-provider-gate] provider gate baseUrl must contain only an HTTPS origin",
    );
  }
  const valuesFile = assertExistingRegularFile(
    path.resolve(requireString(env, "RIVET_K8S_PROVIDER_GATE_VALUES_FILE")),
    "RIVET_K8S_PROVIDER_GATE_VALUES_FILE",
  );
  const requestHeaders =
    rawConfig.requestHeaders === undefined
      ? {}
      : assertObject(rawConfig.requestHeaders, "provider gate requestHeaders");
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (typeof value !== "string")
      throw new Error(
        `[kubernetes-managed-provider-gate] requestHeaders.${name} must be a string`,
      );
  }
  const keyRotation =
    rawConfig.keyRotation === undefined
      ? undefined
      : (() => {
          const value = assertObject(
            rawConfig.keyRotation,
            "provider gate keyRotation",
          );
          return {
            currentSecretName: assertDnsLabel(
              String(value.currentSecretName ?? ""),
              "provider gate keyRotation.currentSecretName",
            ),
            nextSecretName: assertDnsLabel(
              String(value.nextSecretName ?? ""),
              "provider gate keyRotation.nextSecretName",
            ),
            secretKey: String(value.secretKey ?? "encryptionKey"),
          };
        })();
  if (
    keyRotation &&
    keyRotation.currentSecretName === keyRotation.nextSecretName
  ) {
    throw new Error(
      "[kubernetes-managed-provider-gate] key rotation secrets must be different",
    );
  }
  const legacyImport =
    rawConfig.legacyImport === undefined
      ? undefined
      : (() => {
          const value = assertObject(
            rawConfig.legacyImport,
            "provider gate legacyImport",
          );
          return {
            probe: normalizeProbe(
              value.probe,
              "provider gate legacyImport.probe",
              { requireContains: true },
            ),
          };
        })();
  return {
    context,
    allowedContext,
    namespace,
    release,
    baseUrl: baseUrl.origin,
    configFile,
    valuesFile,
    images: buildImages(env),
    registry: {
      server: optionalString(
        env,
        "RIVET_K8S_PROVIDER_GATE_REGISTRY_SERVER",
        "ghcr.io",
      ),
      username: requireString(env, "RIVET_K8S_PROVIDER_GATE_REGISTRY_USERNAME"),
      password: requireString(env, "RIVET_K8S_PROVIDER_GATE_REGISTRY_PASSWORD"),
      secretName: assertDnsLabel(
        optionalString(
          env,
          "RIVET_K8S_PROVIDER_GATE_REGISTRY_SECRET_NAME",
          "rivet-managed-provider-gate-registry",
        ),
        "RIVET_K8S_PROVIDER_GATE_REGISTRY_SECRET_NAME",
      ),
    },
    requestHeaders,
    workflowProbe: normalizeProbe(
      rawConfig.workflowProbe,
      "provider gate workflowProbe",
      { requireBody: true, requireContains: true },
    ),
    webAppProbe: normalizeProbe(
      rawConfig.webAppProbe,
      "provider gate webAppProbe",
      { requireContains: true },
    ),
    legacyImport,
    keyRotation,
    interruptionManifests:
      rawConfig.interruptionManifests === undefined
        ? []
        : Object.entries(
            assertObject(
              rawConfig.interruptionManifests,
              "provider gate interruptionManifests",
            ),
          ).map(([name, value]) => {
            if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
              throw new Error(
                "[kubernetes-managed-provider-gate] interruptionManifests keys must be lowercase DNS-label fragments",
              );
            }
            const manifest = assertObject(
              value,
              `provider gate interruptionManifests.${name}`,
            );
            return {
              name,
              applyFile: assertExistingRegularFileInside(
                configDirectory,
                String(manifest.applyFile ?? ""),
                `provider gate interruptionManifests.${name}.applyFile`,
              ),
              restoreFile: assertExistingRegularFileInside(
                configDirectory,
                String(manifest.restoreFile ?? ""),
                `provider gate interruptionManifests.${name}.restoreFile`,
              ),
              restoreAction: (() => {
                const action = String(manifest.restoreAction ?? "apply");
                if (!["apply", "delete"].includes(action)) {
                  throw new Error(
                    `[kubernetes-managed-provider-gate] provider gate interruptionManifests.${name}.restoreAction must be apply or delete`,
                  );
                }
                return action;
              })(),
            };
          }),
    artifactsDir: assertArtifactPath(
      rootDir,
      optionalString(
        env,
        "RIVET_K8S_PROVIDER_GATE_ARTIFACTS_DIR",
        "artifacts/kubernetes-managed-provider-gate",
      ),
    ),
    deploymentTimeoutSeconds: parsePositiveInteger(
      env,
      "RIVET_K8S_PROVIDER_GATE_DEPLOYMENT_TIMEOUT_SECONDS",
      900,
    ),
    configDirectory,
  };
}
export function imageReference(image) {
  return `${image.repository}@${image.digest}`;
}
