import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  buildManagedReleaseGateConfig,
  imageReference,
  renderManagedReleaseGateValues,
} from "./lib/kubernetes-managed-release-gate-config.mjs";
import { resolveHelmBinOrThrow } from "./lib/k8s-tools.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const mode = process.argv[2] ?? "smoke";
const runnerName = "kubernetes-managed-release-gate";
const ownershipLabel = "rivet.release-gate/owned";
const dependencyLabel = "rivet.release-gate/dependency";
const requireFromApi = createRequire(
  path.join(rootDir, "packages", "studio-server-api", "package.json"),
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomSecret() {
  return randomBytes(36).toString("base64url");
}

function resolveKubectlBin(env) {
  return (
    String(env.RIVET_K8S_KUBECTL_BIN ?? "").trim() ||
    (process.platform === "win32" ? "kubectl.exe" : "kubectl")
  );
}

function commandLine(program, args) {
  return [program, ...args]
    .map((value) => (/[\s"]/u.test(value) ? JSON.stringify(value) : value))
    .join(" ");
}

async function run(program, args, options = {}) {
  const {
    cwd = rootDir,
    input,
    capture = false,
    allowFailure = false,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: capture
        ? ["pipe", "pipe", "pipe"]
        : input == null
          ? "inherit"
          : ["pipe", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    if (input != null && child.stdin) child.stdin.end(input);
    child.once("error", reject);
    child.once("exit", (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0 || allowFailure)
        return resolve({ exitCode, stdout, stderr });
      reject(
        new Error(
          `Command failed with exit code ${exitCode}: ${commandLine(program, args)}${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    });
  });
}

function renderSecrets(namespace, secrets) {
  const metadata = `  namespace: ${namespace}\n  labels:\n    ${ownershipLabel}: "true"\n`;
  const quote = (value) => JSON.stringify(value);
  return `apiVersion: v1
kind: Secret
metadata:
  name: rivet-release-gate-postgres
${metadata}type: Opaque
stringData:
  password: ${quote(secrets.postgresPassword)}
---
apiVersion: v1
kind: Secret
metadata:
  name: rivet-release-gate-object-storage
${metadata}type: Opaque
stringData:
  accessKeyId: ${quote(secrets.objectStorageAccessKey)}
  secretAccessKey: ${quote(secrets.objectStorageSecretKey)}
---
apiVersion: v1
kind: Secret
metadata:
  name: rivet-release-gate-settings
${metadata}type: Opaque
stringData:
  encryptionKey: ${quote(secrets.settingsEncryptionKey)}
---
apiVersion: v1
kind: Secret
metadata:
  name: rivet-release-gate-auth
${metadata}type: Opaque
stringData:
  RIVET_KEY: ${quote(secrets.rivetKey)}
`;
}

function renderAppSettingsSecret(namespace, name, encryptionKey) {
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    ${ownershipLabel}: "true"
type: Opaque
stringData:
  encryptionKey: ${JSON.stringify(encryptionKey)}
`;
}

function renderRegistrySecret(namespace, registry) {
  const auth = Buffer.from(
    `${registry.username}:${registry.password}`,
  ).toString("base64");
  const dockerConfig = JSON.stringify({
    auths: {
      [registry.server]: {
        username: registry.username,
        password: registry.password,
        auth,
      },
    },
  });
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${registry.secretName}
  namespace: ${namespace}
  labels:
    ${ownershipLabel}: "true"
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: ${JSON.stringify(dockerConfig)}
`;
}
function renderDependencies(namespace) {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: release-gate-postgres
  namespace: ${namespace}
  labels: { app.kubernetes.io/part-of: rivet-managed-release-gate }
spec:
  replicas: 1
  selector: { matchLabels: { app: release-gate-postgres } }
  template:
    metadata:
      labels:
        app: release-gate-postgres
        app.kubernetes.io/part-of: rivet-managed-release-gate
    spec:
      nodeSelector: { ${dependencyLabel}: "true" }
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: postgres
          image: postgres:16.8-alpine
          ports: [{ containerPort: 5432 }]
          env:
            - { name: POSTGRES_DB, value: rivet }
            - { name: POSTGRES_USER, value: rivet }
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: rivet-release-gate-postgres, key: password } }
          readinessProbe:
            exec: { command: ["sh", "-ec", "pg_isready -U rivet -d rivet"] }
            periodSeconds: 2
            timeoutSeconds: 2
          volumeMounts: [{ name: data, mountPath: /var/lib/postgresql/data }]
      volumes:
        - name: data
          hostPath:
            path: /var/lib/rivet-managed-release-gate/${namespace}/postgres
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: release-gate-postgres
  namespace: ${namespace}
  labels: { app.kubernetes.io/part-of: rivet-managed-release-gate }
spec:
  selector: { app: release-gate-postgres }
  ports: [{ port: 5432, targetPort: 5432 }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: release-gate-minio
  namespace: ${namespace}
  labels: { app.kubernetes.io/part-of: rivet-managed-release-gate }
spec:
  replicas: 1
  selector: { matchLabels: { app: release-gate-minio } }
  template:
    metadata:
      labels:
        app: release-gate-minio
        app.kubernetes.io/part-of: rivet-managed-release-gate
    spec:
      nodeSelector: { ${dependencyLabel}: "true" }
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: minio
          image: minio/minio:RELEASE.2025-04-22T22-12-26Z
          args: ["server", "/data", "--console-address", ":9001"]
          ports: [{ containerPort: 9000 }]
          env:
            - name: MINIO_ROOT_USER
              valueFrom: { secretKeyRef: { name: rivet-release-gate-object-storage, key: accessKeyId } }
            - name: MINIO_ROOT_PASSWORD
              valueFrom: { secretKeyRef: { name: rivet-release-gate-object-storage, key: secretAccessKey } }
          readinessProbe: { tcpSocket: { port: 9000 }, periodSeconds: 2, timeoutSeconds: 2 }
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
        - name: data
          hostPath:
            path: /var/lib/rivet-managed-release-gate/${namespace}/minio
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: release-gate-minio
  namespace: ${namespace}
  labels: { app.kubernetes.io/part-of: rivet-managed-release-gate }
spec:
  selector: { app: release-gate-minio }
  ports: [{ port: 9000, targetPort: 9000 }]
---
apiVersion: batch/v1
kind: Job
metadata:
  name: release-gate-create-bucket
  namespace: ${namespace}
  labels: { app.kubernetes.io/part-of: rivet-managed-release-gate }
spec:
  backoffLimit: 30
  template:
    metadata:
      labels: { app.kubernetes.io/part-of: rivet-managed-release-gate }
    spec:
      restartPolicy: OnFailure
      containers:
        - name: create-bucket
          image: minio/mc:RELEASE.2025-04-16T18-13-26Z
          command: ["sh", "-ec"]
          args:
            - >-
              until mc alias set release-gate http://release-gate-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD";
              do sleep 2; done; mc mb --ignore-existing release-gate/rivet-release-gate
          env:
            - name: MINIO_ROOT_USER
              valueFrom: { secretKeyRef: { name: rivet-release-gate-object-storage, key: accessKeyId } }
            - name: MINIO_ROOT_PASSWORD
              valueFrom: { secretKeyRef: { name: rivet-release-gate-object-storage, key: secretAccessKey } }
`;
}

function extractWebAppRevisionKey(html) {
  const match = html.match(/\bdata-rivet-web-app-config="([^"]*)"/);
  if (!match?.[1])
    throw new Error("Web app HTML did not contain an action revision key");
  const config = JSON.parse(
    match[1].replace(
      /&(quot|#039|lt|gt|amp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&#039;": "'",
          "&gt;": ">",
          "&lt;": "<",
          "&quot;": '"',
        })[entity] ?? entity,
    ),
  );
  if (typeof config.revisionKey !== "string" || !config.revisionKey)
    throw new Error("Web app revision key is invalid");
  return config.revisionKey;
}

function getReleaseGateWorkflowValue(result) {
  const value = result?.value?.type === "any" ? result.value.value : result;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Workflow response did not contain the expected object value: ${JSON.stringify(result)}`,
    );
  }
  return value;
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    headers: {
      accept: "application/json",
      ...(options.body == null ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${route} returned ${response.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`,
    );
  return body;
}

async function waitFor(description, operation, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `Timed out waiting for ${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
function createDeferred() {
  let settled = false;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    get settled() {
      return settled;
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

async function waitForPromise(description, promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function isWebSocketActionTerminalMessage(message) {
  return [
    "action.completed",
    "action.failed",
    "action.cancelled",
    "action.interrupted",
    "action.rejected",
    "run.rejected",
  ].includes(message.type);
}

function openWebSocketAction(
  baseUrl,
  {
    componentId = "release-gate-run-button",
    requestId = `release-gate-${randomUUID()}`,
    revisionKey,
    resume,
    state = { prompt: "managed-release-websocket" },
  } = {},
) {
  const { WebSocket } = requireFromApi("ws");
  const socketUrl = `${baseUrl.replace(/^http/u, "ws")}/apps/release-gate-web-app/actions/ws`;
  const accepted = createDeferred();
  const ready = createDeferred();
  const terminal = createDeferred();
  const messages = [];
  let highestSequence = 0;
  const socket = new WebSocket(socketUrl, {
    origin: baseUrl,
    handshakeTimeout: 30_000,
  });

  socket.once("error", (error) => {
    ready.reject(error);
    accepted.reject(error);
    terminal.reject(error);
  });
  socket.once("open", () => {
    socket.send(JSON.stringify({ type: "client.hello", protocolVersion: 1 }));
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (typeof message.sequence === "number")
        highestSequence = Math.max(highestSequence, message.sequence);
      if (message.type === "server.ready") {
        ready.resolve(message);
        socket.send(
          JSON.stringify(
            resume
              ? {
                  type: "run.resume",
                  runId: resume.runId,
                  lastSequence: resume.lastSequence,
                }
              : {
                  type: "action.start",
                  componentId,
                  requestId,
                  revisionKey,
                  state,
                },
          ),
        );
        return;
      }
      if (message.type === "action.accepted") accepted.resolve(message);
      if (isWebSocketActionTerminalMessage(message)) terminal.resolve(message);
    } catch (error) {
      ready.reject(error);
      accepted.reject(error);
    }
  });

  return {
    accepted: accepted.promise,
    close() {
      socket.close();
    },
    getHighestSequence: () => highestSequence,
    messages,
    ready: ready.promise,
    socket,
    terminal: terminal.promise,
  };
}

async function runWebSocketAction(baseUrl, revisionKey) {
  const action = openWebSocketAction(baseUrl, { revisionKey });
  try {
    await waitForPromise(
      "web-app WebSocket acceptance",
      action.accepted,
      30_000,
    );
    const terminal = await waitForPromise(
      "web-app WebSocket action",
      action.terminal,
      45_000,
    );
    if (terminal.type !== "action.completed") {
      throw new Error(
        `WebSocket action did not complete: ${JSON.stringify(terminal)}`,
      );
    }
    return action.messages;
  } finally {
    action.close();
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

class ManagedReleaseGate {
  constructor(config, kubectlBin, helmBin) {
    this.config = config;
    this.kubectlBin = kubectlBin;
    this.helmBin = helmBin;
    this.portForward = null;
    this.secrets = null;
  }

  kubectl(args, options) {
    return run(
      this.kubectlBin,
      ["--context", this.config.context, ...args],
      options,
    );
  }

  requestWorkflow(baseUrl, route, options = {}) {
    if (!this.secrets?.rivetKey) {
      throw new Error("Release-gate workflow key is not initialized");
    }
    return requestJson(baseUrl, route, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        authorization: `Bearer ${this.secrets.rivetKey}`,
      },
    });
  }

  async artifact(name, content) {
    const filePath = path.join(this.config.artifactsDir, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }

  async assertContext() {
    const current = (
      await run(this.kubectlBin, ["config", "current-context"], {
        capture: true,
      })
    ).stdout.trim();
    if (
      current !== this.config.context ||
      current !== this.config.allowedContext
    ) {
      throw new Error(
        `[${runnerName}] refusing kube context ${JSON.stringify(current)}; both release-gate context values must match it`,
      );
    }
  }

  async deleteOwnedNamespace() {
    const existing = await this.kubectl(
      ["get", "namespace", this.config.namespace, "-o", "json"],
      { capture: true, allowFailure: true },
    );
    if (existing.exitCode !== 0) return;
    const namespace = JSON.parse(existing.stdout);
    if (namespace.metadata?.labels?.[ownershipLabel] !== "true") {
      throw new Error(
        `[${runnerName}] refusing to delete ${this.config.namespace}: ownership label is absent`,
      );
    }
    await this.kubectl([
      "delete",
      "namespace",
      this.config.namespace,
      "--wait=false",
    ]);
    await this.kubectl([
      "wait",
      "--for=delete",
      `namespace/${this.config.namespace}`,
      "--timeout=180s",
    ]);
  }

  async createNamespace() {
    await this.deleteOwnedNamespace();
    await this.kubectl(["create", "namespace", this.config.namespace]);
    await this.kubectl([
      "label",
      "namespace",
      this.config.namespace,
      `${ownershipLabel}=true`,
      "--overwrite",
    ]);
  }

  async capture(stage) {
    const commands = [
      ["get", "all", "-n", this.config.namespace, "-o", "wide"],
      [
        "get",
        "events",
        "-n",
        this.config.namespace,
        "--sort-by=.metadata.creationTimestamp",
      ],
      ["get", "pods", "-n", this.config.namespace, "-o", "yaml"],
      ["describe", "pods", "-n", this.config.namespace],
    ];
    for (const [index, args] of commands.entries()) {
      const result = await this.kubectl(args, {
        capture: true,
        allowFailure: true,
      });
      await this.artifact(
        `${stage}/kubectl-${index}.log`,
        `${result.stdout}\n${result.stderr}`,
      );
    }
    const pods = await this.kubectl(
      ["get", "pods", "-n", this.config.namespace, "-o", "name"],
      { capture: true, allowFailure: true },
    );
    for (const pod of pods.stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)) {
      const logs = await this.kubectl(
        [
          "logs",
          "-n",
          this.config.namespace,
          pod,
          "--all-containers=true",
          "--tail=400",
        ],
        { capture: true, allowFailure: true },
      );
      await this.artifact(
        `${stage}/${pod.replace("/", "-")}.log`,
        `${logs.stdout}\n${logs.stderr}`,
      );
    }
    const manifest = await run(
      this.helmBin,
      [
        "get",
        "manifest",
        this.config.release,
        "--namespace",
        this.config.namespace,
      ],
      { capture: true, allowFailure: true },
    );
    await this.artifact(
      `${stage}/helm-manifest.yaml`,
      `${manifest.stdout}\n${manifest.stderr}`,
    );
  }

  async createRegistrySecret() {
    await this.kubectl(["apply", "-f", "-"], {
      input: renderRegistrySecret(this.config.namespace, this.config.registry),
    });
  }

  async installDependencies() {
    const controlPlane = (
      await this.kubectl(
        [
          "get",
          "nodes",
          "-l",
          "node-role.kubernetes.io/control-plane",
          "-o",
          "jsonpath={.items[0].metadata.name}",
        ],
        { capture: true },
      )
    ).stdout.trim();
    if (!controlPlane)
      throw new Error(
        `[${runnerName}] no control-plane node available for disposable dependencies`,
      );
    await this.kubectl([
      "label",
      "node",
      controlPlane,
      `${dependencyLabel}=true`,
      "--overwrite",
    ]);
    const secrets = {
      postgresPassword: randomSecret(),
      objectStorageAccessKey: "release-gate",
      objectStorageSecretKey: randomSecret(),
      settingsEncryptionKey: randomSecret(),
      rivetKey: randomSecret(),
    };
    this.secrets = secrets;
    await this.kubectl(["apply", "-f", "-"], {
      input: renderSecrets(this.config.namespace, secrets),
    });
    await this.kubectl(["apply", "-f", "-"], {
      input: renderDependencies(this.config.namespace),
    });
    await this.kubectl([
      "rollout",
      "status",
      "deployment/release-gate-postgres",
      "-n",
      this.config.namespace,
      "--timeout=180s",
    ]);
    await this.kubectl([
      "rollout",
      "status",
      "deployment/release-gate-minio",
      "-n",
      this.config.namespace,
      "--timeout=180s",
    ]);
    await this.kubectl([
      "wait",
      "--for=condition=complete",
      "job/release-gate-create-bucket",
      "-n",
      this.config.namespace,
      "--timeout=240s",
    ]);
  }
  async installChart() {
    const valuesPath = path.join(
      this.config.artifactsDir,
      "release-gate.values.json",
    );
    await fs.mkdir(this.config.artifactsDir, { recursive: true });
    await fs.writeFile(
      valuesPath,
      `${JSON.stringify(renderManagedReleaseGateValues(this.config), null, 2)}\n`,
      "utf8",
    );
    await run(this.helmBin, [
      "upgrade",
      "--install",
      this.config.release,
      "deploy/studio-server/helm",
      "--namespace",
      this.config.namespace,
      "--values",
      path.join(rootDir, "deploy", "studio-server", "helm", "overlays", "managed-release-gate.yaml"),
      "--values",
      valuesPath,
      "--wait",
      "--wait-for-jobs",
      "--timeout",
      `${this.config.deploymentTimeoutSeconds}s`,
    ]);
    const manifest = await run(
      this.helmBin,
      [
        "get",
        "manifest",
        this.config.release,
        "--namespace",
        this.config.namespace,
      ],
      { capture: true },
    );
    await this.artifact("installed/helm-manifest.yaml", manifest.stdout);
    for (const [component, image] of Object.entries(this.config.images)) {
      if (!manifest.stdout.includes(imageReference(image))) {
        throw new Error(
          `[${runnerName}] ${component} manifest did not use the immutable candidate digest`,
        );
      }
    }
  }

  async openProxy() {
    if (this.portForward && !this.portForward.killed) {
      this.portForward.kill();
      this.portForward = null;
    }
    const port = await findFreePort();
    const child = spawn(
      this.kubectlBin,
      [
        "--context",
        this.config.context,
        "-n",
        this.config.namespace,
        "port-forward",
        `service/${this.config.release}-proxy`,
        `${port}:80`,
      ],
      {
        cwd: rootDir,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    this.portForward = child;
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      "proxy readiness",
      async () => {
        if (child.exitCode != null) throw new Error(output);
        const response = await fetch(`${baseUrl}/readyz`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok)
          throw new Error(`/readyz returned ${response.status}`);
        return response;
      },
      60_000,
    );
    return baseUrl;
  }

  async exercisePersistence(baseUrl) {
    const fixtureContents = await fs.readFile(
      path.join(
        rootDir,
        "deploy",
        "studio-server",
        "scripts",
        "fixtures",
        "managed-release-gate.rivet-project",
      ),
      "utf8",
    );
    const upload = await requestJson(
      baseUrl,
      "/api/workflows/projects/upload",
      {
        method: "POST",
        body: JSON.stringify({
          folderRelativePath: "",
          fileName: "managed-release-gate.rivet-project",
          contents: fixtureContents,
        }),
      },
    );
    const relativePath = upload.project?.relativePath;
    if (typeof relativePath !== "string")
      throw new Error("Project upload did not return relativePath");
    await requestJson(baseUrl, "/api/workflows/projects/publish", {
      method: "POST",
      body: JSON.stringify({
        relativePath,
        settings: { endpointName: "managed-release-workflow" },
      }),
    });
    await requestJson(baseUrl, "/api/workflows/projects/web-apps/publish", {
      method: "POST",
      body: JSON.stringify({
        relativePath,
        publications: [
          { uiGraphId: "release-gate-web-app", slug: "release-gate-web-app" },
        ],
      }),
    });

    await this.requestWorkflow(baseUrl, "/workflows/managed-release-workflow", {
      method: "POST",
      body: JSON.stringify({ input: "published" }),
    });
    await this.requestWorkflow(baseUrl, "/workflows-latest/managed-release-workflow", {
      method: "POST",
      body: JSON.stringify({ input: "latest" }),
    });
    const publishedHtml = await (
      await fetch(`${baseUrl}/apps/release-gate-web-app`, {
        signal: AbortSignal.timeout(30_000),
      })
    ).text();
    const latestHtml = await (
      await fetch(`${baseUrl}/apps-latest/release-gate-web-app`, {
        signal: AbortSignal.timeout(30_000),
      })
    ).text();
    if (
      !publishedHtml.includes("Managed release gate app") ||
      !latestHtml.includes("Managed release gate app")
    ) {
      throw new Error(
        "Published/latest web-app HTML did not contain the expected app",
      );
    }
    const publishedRevision = extractWebAppRevisionKey(publishedHtml);
    const latestRevision = extractWebAppRevisionKey(latestHtml);
    for (const [route, revisionKey, prompt] of [
      [
        "/apps/release-gate-web-app/actions/run",
        publishedRevision,
        "published-app",
      ],
      [
        "/apps-latest/release-gate-web-app/actions/run",
        latestRevision,
        "latest-app",
      ],
    ]) {
      await requestJson(baseUrl, route, {
        method: "POST",
        timeoutMs: 45_000,
        body: JSON.stringify({
          componentId: "release-gate-run-button",
          revisionKey,
          state: { prompt },
        }),
      });
    }
    const socketMessages = await runWebSocketAction(baseUrl, publishedRevision);
    if (
      !socketMessages.some((message) => message.type === "action.accepted") ||
      !socketMessages.some((message) => message.type === "action.completed")
    ) {
      throw new Error(
        "WebSocket action did not emit accepted and completed messages",
      );
    }

    const settings = await requestJson(
      baseUrl,
      "/api/app-settings/environment-variables",
      {
        method: "PATCH",
        body: JSON.stringify({
          variables: [
            {
              name: "RIVET_RELEASE_GATE_VALUE",
              value: "managed-persistence",
              browserAccess: false,
            },
          ],
        }),
      },
    );
    const environmentVariableId = settings.variables?.[0]?.id;
    if (typeof environmentVariableId !== "string")
      throw new Error("App Settings update did not return variable id");
    const savedValue = await requestJson(
      baseUrl,
      `/api/app-settings/environment-variables/${encodeURIComponent(environmentVariableId)}/value`,
    );
    if (savedValue.value !== "managed-persistence")
      throw new Error("App Settings value did not round-trip");
    await waitFor(
      "runtime environment propagation",
      async () => {
        const result = await this.requestWorkflow(
          baseUrl,
          "/workflows/managed-release-workflow",
          {
            method: "POST",
            body: JSON.stringify({ input: "runtime-environment" }),
          },
        );
        const value = getReleaseGateWorkflowValue(result);
        if (value.environmentValue !== "managed-persistence")
          throw new Error(
            `Execution runtime did not receive the App Settings environment value: ${JSON.stringify(result)}`,
          );
        return result;
      },
      30_000,
    );

    let replayRecordingId;
    await waitFor(
      "recordings and statistics",
      async () => {
        const catalog = await requestJson(
          baseUrl,
          "/api/workflows/recordings/workflows",
        );
        const workflow = catalog.workflows?.find(
          (entry) => entry.project?.relativePath === relativePath,
        );
        if (!workflow || workflow.totalRuns < 6)
          throw new Error("recordings have not converged");
        const page = await requestJson(
          baseUrl,
          `/api/workflows/recordings/workflows/${encodeURIComponent(workflow.workflowId)}/runs?page=1&pageSize=50&status=all`,
        );
        if (!Array.isArray(page.runs) || page.runs.length < 6)
          throw new Error("recording detail has not converged");
        const candidateReplayRecordingId = page.runs[0]?.id;
        if (
          typeof candidateReplayRecordingId !== "string" ||
          !candidateReplayRecordingId
        )
          throw new Error("recording detail did not include a replayable run");
        const replay = await fetch(
          `${baseUrl}/api/workflows/recordings/${encodeURIComponent(candidateReplayRecordingId)}/replay-project`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (!replay.ok)
          throw new Error(`recording replay returned ${replay.status}`);
        replayRecordingId = candidateReplayRecordingId;
        const targets = await requestJson(
          baseUrl,
          "/api/workflows/run-statistics/targets?surface=web_app",
        );
        if (
          !targets.targets?.some(
            (entry) => entry.target?.workflowId === workflow.workflowId,
          )
        )
          throw new Error(
            "statistics catalog did not contain the web-app action",
          );
      },
      90_000,
    );
    if (typeof replayRecordingId !== "string")
      throw new Error("recording replay identity did not converge");
    return { environmentVariableId, publishedRevision, replayRecordingId };
  }

  async upgradeChart(overrides) {
    const args = [
      "upgrade",
      this.config.release,
      "deploy/studio-server/helm",
      "--namespace",
      this.config.namespace,
      "--reuse-values",
    ];
    for (const [key, value] of Object.entries(overrides)) {
      args.push("--set-string", `${key}=${value}`);
    }
    args.push(
      "--wait",
      "--wait-for-jobs",
      "--timeout",
      `${this.config.deploymentTimeoutSeconds}s`,
    );
    await run(this.helmBin, args);
  }

  async waitForReady(baseUrl, description, timeoutMs = 90_000) {
    return waitFor(
      description,
      async () => {
        const response = await fetch(`${baseUrl}/readyz`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok)
          throw new Error(`/readyz returned ${response.status}`);
        return response;
      },
      timeoutMs,
    );
  }

  async assertPersistedEnvironment(baseUrl, state) {
    const savedValue = await requestJson(
      baseUrl,
      `/api/app-settings/environment-variables/${encodeURIComponent(state.environmentVariableId)}/value`,
    );
    if (savedValue.value !== "managed-persistence") {
      throw new Error(
        "App Settings value did not survive the managed recovery scenario",
      );
    }
    await waitFor(
      "execution runtime environment recovery",
      async () => {
        const result = await this.requestWorkflow(
          baseUrl,
          "/workflows/managed-release-workflow",
          {
            method: "POST",
            body: JSON.stringify({ input: "runtime-environment" }),
          },
        );
        const value = getReleaseGateWorkflowValue(result);
        if (value.environmentValue !== "managed-persistence") {
          throw new Error(
            `Execution runtime did not receive the persisted App Settings environment value: ${JSON.stringify(result)}`,
          );
        }
        return result;
      },
      90_000,
    );
  }

  async rotateAppSettingsKey(state) {
    if (!this.secrets)
      throw new Error("Release-gate secrets were not initialized");
    const oldSecretName = "rivet-release-gate-settings";
    const newSecretName = "rivet-release-gate-settings-rotated";
    await this.kubectl(["apply", "-f", "-"], {
      input: renderAppSettingsSecret(
        this.config.namespace,
        newSecretName,
        randomSecret(),
      ),
    });

    // Every live pod first learns both keys while writes remain on the old primary.
    await this.upgradeChart({
      "appSettings.encryptionKeySecretName": oldSecretName,
      "appSettings.previousEncryptionKeySecretName": newSecretName,
    });
    let baseUrl = await this.openProxy();
    await this.assertPersistedEnvironment(baseUrl, state);

    // Then switch the primary while every generation can still decrypt either form.
    await this.upgradeChart({
      "appSettings.encryptionKeySecretName": newSecretName,
      "appSettings.previousEncryptionKeySecretName": oldSecretName,
    });
    baseUrl = await this.openProxy();
    await this.assertPersistedEnvironment(baseUrl, state);

    // A final rollout proves that every touched setting was re-encrypted with the new primary.
    await this.upgradeChart({
      "appSettings.encryptionKeySecretName": newSecretName,
      "appSettings.previousEncryptionKeySecretName": "",
    });
    baseUrl = await this.openProxy();
    await this.assertPersistedEnvironment(baseUrl, state);
    return baseUrl;
  }

  async setDependencyReplicas(component, replicas) {
    await this.kubectl([
      "scale",
      `deployment/release-gate-${component}`,
      "-n",
      this.config.namespace,
      `--replicas=${replicas}`,
    ]);
  }

  async verifyManagedDependencyRecovery(baseUrl, state) {
    await this.setDependencyReplicas("minio", 0);
    try {
      await waitFor(
        "object-storage readiness failure",
        async () => {
          const response = await fetch(`${baseUrl}/readyz`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok)
            throw new Error("expected the managed runtime to become unready");
          return response;
        },
        60_000,
      );
      const unavailableReplay = await fetch(
        `${baseUrl}/api/workflows/recordings/${encodeURIComponent(state.replayRecordingId)}/replay-project`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (unavailableReplay.ok)
        throw new Error(
          "Object-storage outage still served a recording replay",
        );
    } finally {
      await this.setDependencyReplicas("minio", 1);
      await this.kubectl([
        "rollout",
        "status",
        "deployment/release-gate-minio",
        "-n",
        this.config.namespace,
        "--timeout=180s",
      ]);
    }
    await this.waitForReady(baseUrl, "object-storage readiness recovery");
    const recoveredReplay = await fetch(
      `${baseUrl}/api/workflows/recordings/${encodeURIComponent(state.replayRecordingId)}/replay-project`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!recoveredReplay.ok)
      throw new Error(
        `Recording replay did not recover after object storage returned: ${recoveredReplay.status}`,
      );

    await this.setDependencyReplicas("postgres", 0);
    try {
      await waitFor(
        "PostgreSQL readiness failure",
        async () => {
          const response = await fetch(`${baseUrl}/readyz`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (response.ok)
            throw new Error("expected the managed runtime to become unready");
          return response;
        },
        60_000,
      );
    } finally {
      await this.setDependencyReplicas("postgres", 1);
      await this.kubectl([
        "rollout",
        "status",
        "deployment/release-gate-postgres",
        "-n",
        this.config.namespace,
        "--timeout=180s",
      ]);
    }
    await this.waitForReady(baseUrl, "PostgreSQL readiness recovery", 120_000);
    await this.assertPersistedEnvironment(baseUrl, state);
  }

  async getWebAppActionOwner(runId) {
    if (!/^[A-Za-z0-9_-]+$/u.test(runId))
      throw new Error("Web app action run ID is invalid");
    const postgresPod = (
      await this.kubectl(
        [
          "get",
          "pods",
          "-n",
          this.config.namespace,
          "-l",
          "app=release-gate-postgres",
          "-o",
          "jsonpath={.items[0].metadata.name}",
        ],
        { capture: true },
      )
    ).stdout.trim();
    if (!postgresPod)
      throw new Error("Release-gate PostgreSQL pod is unavailable");
    const query = `SELECT host_id FROM web_app_action_runs WHERE run_id = '${runId}';`;
    return waitFor(
      "WebSocket action owner persistence",
      async () => {
        const result = await this.kubectl(
          [
            "exec",
            "-n",
            this.config.namespace,
            postgresPod,
            "--",
            "psql",
            "-U",
            "rivet",
            "-d",
            "rivet",
            "-At",
            "-c",
            query,
          ],
          { capture: true },
        );
        const owner = result.stdout.trim();
        if (!owner) throw new Error(`run ${runId} has no persisted owner`);
        return owner;
      },
      30_000,
    );
  }

  async verifyWebSocketOwnerInterruption(baseUrl, revisionKey) {
    const action = openWebSocketAction(baseUrl, {
      componentId: "release-gate-long-run-button",
      revisionKey,
      state: { prompt: "managed-release-owner-loss" },
    });
    const accepted = await waitForPromise(
      "long-running WebSocket action acceptance",
      action.accepted,
      30_000,
    );
    action.socket.terminate();
    const ownerPod = await this.getWebAppActionOwner(accepted.runId);
    // A normal deletion drains gracefully and only exercises intentional shutdown.
    // Force deletion leaves the durable lease behind, which is the recovery case
    // this release gate is meant to prove.
    await this.kubectl([
      "delete",
      "pod",
      "-n",
      this.config.namespace,
      ownerPod,
      "--force",
      "--grace-period=0",
      "--wait=false",
    ]);
    await this.kubectl([
      "wait",
      "--for=delete",
      `pod/${ownerPod}`,
      "-n",
      this.config.namespace,
      "--timeout=90s",
    ]);
    const executionSelector = `app.kubernetes.io/instance=${this.config.release},app.kubernetes.io/component=execution`;
    await waitFor(
      "execution replacement after WebSocket owner loss",
      async () => {
        const result = await this.kubectl(
          [
            "get",
            "pods",
            "-n",
            this.config.namespace,
            "-l",
            executionSelector,
            "-o",
            "json",
          ],
          { capture: true },
        );
        const readyPods =
          JSON.parse(result.stdout).items?.filter(
            (pod) =>
              pod.metadata?.name !== ownerPod &&
              pod.status?.phase === "Running" &&
              pod.status?.conditions?.some(
                (condition) =>
                  condition.type === "Ready" && condition.status === "True",
              ),
          ) ?? [];
        if (readyPods.length < 2)
          throw new Error(
            "execution replacement is not ready on both replicas yet",
          );
        return readyPods;
      },
      300_000,
    );

    await waitFor(
      "interrupted WebSocket action replay",
      async () => {
        const resumed = openWebSocketAction(baseUrl, {
          resume: { runId: accepted.runId, lastSequence: accepted.sequence },
          revisionKey,
        });
        try {
          const terminal = await waitForPromise(
            "interrupted WebSocket action replay attempt",
            resumed.terminal,
            30_000,
          );
          if (terminal.type !== "action.interrupted") {
            throw new Error(
              `Expected an interrupted WebSocket action after owner loss, received ${JSON.stringify(terminal)}`,
            );
          }
          if (resumed.getHighestSequence() <= accepted.sequence) {
            throw new Error(
              "WebSocket action resume did not replay a terminal event after owner loss",
            );
          }
          return terminal;
        } finally {
          resumed.close();
        }
      },
      120_000,
      1_000,
    );
  }

  async replaceWorkload(baseUrl, component) {
    const selector = `app.kubernetes.io/instance=${this.config.release},app.kubernetes.io/component=${component}`;
    const podResult = await this.kubectl(
      [
        "get",
        "pods",
        "-n",
        this.config.namespace,
        "-l",
        selector,
        "-o",
        "json",
      ],
      { capture: true },
    );
    const pod = JSON.parse(podResult.stdout).items?.[0];
    const podName = pod?.metadata?.name;
    const podUid = pod?.metadata?.uid;
    if (typeof podName !== "string" || typeof podUid !== "string")
      throw new Error(`No ${component} pod was available for replacement`);

    await this.kubectl([
      "delete",
      "pod",
      "-n",
      this.config.namespace,
      podName,
      "--wait=false",
    ]);
    const target =
      component === "backend"
        ? `statefulset/${this.config.release}-backend`
        : `deployment/${this.config.release}-${component}`;
    await this.kubectl([
      "rollout",
      "status",
      target,
      "-n",
      this.config.namespace,
      "--timeout=300s",
    ]);
    const replacement = await waitFor(
      `${component} replacement pod`,
      async () => {
        const result = await this.kubectl(
          [
            "get",
            "pods",
            "-n",
            this.config.namespace,
            "-l",
            selector,
            "-o",
            "json",
          ],
          { capture: true },
        );
        const replacement = JSON.parse(result.stdout).items?.find(
          (item) =>
            item.metadata?.uid !== podUid &&
            item.status?.phase === "Running" &&
            item.status?.conditions?.some(
              (condition) =>
                condition.type === "Ready" && condition.status === "True",
            ),
        );
        if (!replacement)
          throw new Error(
            `a ready replacement for ${podName} is not available yet`,
          );
        return replacement;
      },
      300_000,
    );
    await waitFor(
      `${component} proxy recovery`,
      async () => {
        const response = await fetch(`${baseUrl}/readyz`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok)
          throw new Error(`/readyz returned ${response.status}`);
        return response;
      },
      90_000,
    );
    const replacementName = replacement.metadata?.name;
    if (typeof replacementName !== "string")
      throw new Error(`Replacement ${component} pod has no name`);
    return replacementName;
  }

  async verifyAfterReplacement(baseUrl, state) {
    await this.replaceWorkload(baseUrl, "backend");
    const savedValue = await requestJson(
      baseUrl,
      `/api/app-settings/environment-variables/${encodeURIComponent(state.environmentVariableId)}/value`,
    );
    if (savedValue.value !== "managed-persistence")
      throw new Error("App Settings did not survive backend replacement");
    const replacementExecutionPod = await this.replaceWorkload(
      baseUrl,
      "execution",
    );
    await waitFor(
      "execution through the replacement pod",
      async () => {
        const runtimeResult = await this.requestWorkflow(
          baseUrl,
          "/workflows/managed-release-workflow",
          {
            method: "POST",
            body: JSON.stringify({ input: "recovered" }),
          },
        );
        const value = getReleaseGateWorkflowValue(runtimeResult);
        if (value.hostname !== replacementExecutionPod) {
          throw new Error(
            `Workflow request did not reach replacement execution pod ${replacementExecutionPod}`,
          );
        }
        if (value.environmentValue !== "managed-persistence") {
          throw new Error(
            `Replacement execution pod did not receive the persisted App Settings environment value: ${JSON.stringify(runtimeResult)}`,
          );
        }
        return runtimeResult;
      },
      90_000,
    );
    const app = await fetch(`${baseUrl}/apps/release-gate-web-app`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!app.ok)
      throw new Error(
        `Web app did not survive execution replacement: ${app.status}`,
      );
  }

  async disruptionChecks() {
    await this.kubectl([
      "rollout",
      "restart",
      `deployment/${this.config.release}-proxy`,
      "-n",
      this.config.namespace,
    ]);
    await this.kubectl([
      "rollout",
      "status",
      `deployment/${this.config.release}-proxy`,
      "-n",
      this.config.namespace,
      "--timeout=300s",
    ]);
    const baseUrl = await this.openProxy();
    await this.requestWorkflow(baseUrl, "/workflows/managed-release-workflow", {
      method: "POST",
      body: JSON.stringify({ input: "after-proxy-rollout" }),
    });
    const executionPodsResult = await this.kubectl(
      [
        "get",
        "pods",
        "-n",
        this.config.namespace,
        "-l",
        `app.kubernetes.io/instance=${this.config.release},app.kubernetes.io/component=execution`,
        "-o",
        "json",
      ],
      { capture: true },
    );
    const executionPods =
      JSON.parse(executionPodsResult.stdout).items?.filter(
        (pod) =>
          typeof pod.spec?.nodeName === "string" &&
          pod.status?.phase === "Running" &&
          pod.status?.conditions?.some(
            (condition) =>
              condition.type === "Ready" && condition.status === "True",
          ),
      ) ?? [];
    const executionPodsByNode = new Map();
    for (const pod of executionPods) {
      const nodeName = pod.spec.nodeName;
      executionPodsByNode.set(nodeName, [
        ...(executionPodsByNode.get(nodeName) ?? []),
        pod,
      ]);
    }
    const node = [...executionPodsByNode.entries()].find(
      ([, pods]) => pods.length === 1,
    )?.[0];
    if (executionPods.length < 2 || executionPodsByNode.size < 2 || !node) {
      throw new Error(
        "Execution replicas must be ready on separate nodes before node-drain coverage",
      );
    }
    try {
      await this.kubectl([
        "drain",
        node,
        "--ignore-daemonsets",
        "--delete-emptydir-data",
        "--force",
        "--timeout=180s",
      ]);
      await this.kubectl([
        "rollout",
        "status",
        `deployment/${this.config.release}-execution`,
        "-n",
        this.config.namespace,
        "--timeout=300s",
      ]);
      await waitFor(
        "workflow recovery after execution node drain",
        () =>
          this.requestWorkflow(baseUrl, "/workflows/managed-release-workflow", {
            method: "POST",
            body: JSON.stringify({ input: "after-node-drain" }),
          }),
        90_000,
        1_000,
      );
    } finally {
      await this.kubectl(["uncordon", node], { allowFailure: true });
    }
  }

  async close() {
    if (this.portForward && !this.portForward.killed) this.portForward.kill();
    if (!this.config.keepNamespace) await this.deleteOwnedNamespace();
  }
}

async function main() {
  const config = buildManagedReleaseGateConfig({ rootDir, mode });
  const gate = new ManagedReleaseGate(
    config,
    resolveKubectlBin(process.env),
    resolveHelmBinOrThrow(rootDir, {
      env: process.env,
      launcherName: runnerName,
    }),
  );
  await fs.mkdir(config.artifactsDir, { recursive: true });
  await gate.artifact(
    "config.json",
    `${JSON.stringify({ mode: config.mode, context: config.context, namespace: config.namespace, release: config.release, images: Object.fromEntries(Object.entries(config.images).map(([key, image]) => [key, imageReference(image)])) }, null, 2)}\n`,
  );
  let completed = false;
  try {
    await gate.assertContext();
    await gate.createNamespace();
    await gate.createRegistrySecret();
    await gate.installDependencies();
    await gate.installChart();
    const baseUrl = await gate.openProxy();
    await requestJson(baseUrl, "/api/config");
    const persistedState = await gate.exercisePersistence(baseUrl);
    await gate.verifyAfterReplacement(baseUrl, persistedState);
    if (config.mode === "release") {
      await gate.verifyWebSocketOwnerInterruption(
        baseUrl,
        persistedState.publishedRevision,
      );
      await gate.disruptionChecks();
      const rotatedBaseUrl = await gate.rotateAppSettingsKey(persistedState);
      await gate.verifyManagedDependencyRecovery(
        rotatedBaseUrl,
        persistedState,
      );
    }
    await gate.capture("success");
    completed = true;
    console.log(`[${runnerName}] ${config.mode} gate passed`);
  } catch (error) {
    try {
      await gate.capture("failure");
    } catch (captureError) {
      console.error(`[${runnerName}] artifact capture failed:`, captureError);
    }
    throw error;
  } finally {
    try {
      await gate.close();
    } catch (cleanupError) {
      console.error(`[${runnerName}] cleanup failed:`, cleanupError);
      if (completed) throw cleanupError;
    }
  }
}

await main();
