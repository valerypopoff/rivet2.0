import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildManagedProviderGateConfig,
  imageReference,
} from "./lib/kubernetes-managed-provider-gate-config.mjs";
import { resolveHelmBinOrThrow } from "./lib/k8s-tools.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runnerName = "kubernetes-managed-provider-gate";
const registrySecretOwnerLabel = "app.kubernetes.io/managed-by";

function resolveKubectlBin(env) {
  return String(env.KUBECTL_BIN ?? "kubectl").trim() || "kubectl";
}

function run(
  command,
  args,
  { cwd = rootDir, input, capture = false, allowFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const result = { exitCode: exitCode ?? 1, stdout, stderr };
      if (result.exitCode !== 0 && !allowFailure) {
        reject(
          new Error(
            `[${runnerName}] ${command} ${args.join(" ")} failed with ${result.exitCode}: ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(capture || allowFailure ? result : undefined);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function waitFor(description, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `[${runnerName}] timed out waiting for ${description}: ${latestError instanceof Error ? latestError.message : String(latestError)}`,
  );
}

function renderRegistrySecret(namespace, registry) {
  const auth = Buffer.from(
    `${registry.username}:${registry.password}`,
  ).toString("base64");
  const dockerConfig = Buffer.from(
    JSON.stringify({ auths: { [registry.server]: { auth } } }),
  ).toString("base64");
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${registry.secretName}
  namespace: ${namespace}
  labels:
    ${registrySecretOwnerLabel}: ${runnerName}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${dockerConfig}
`;
}

function parseItems(value) {
  if (value?.kind === "List") return value.items ?? [];
  return [value];
}

function canonicalJson(text, description) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    throw new Error(`[${runnerName}] ${description} did not return JSON`);
  }
}

class ManagedProviderGate {
  constructor(config, kubectlBin, helmBin) {
    this.config = config;
    this.kubectlBin = kubectlBin;
    this.helmBin = helmBin;
    this.tempDir = null;
    this.candidateValuesFile = null;
  }

  kubectl(args, options) {
    return run(
      this.kubectlBin,
      ["--context", this.config.context, ...args],
      options,
    );
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
        `[${runnerName}] refusing kube context ${JSON.stringify(current)}; both provider-gate context values must match it`,
      );
    }
  }

  async createRegistrySecret() {
    const existing = await this.kubectl(
      ["get", "secret", this.config.registry.secretName, "-o", "json"],
      { capture: true, allowFailure: true },
    );
    if (
      existing.exitCode !== 0 &&
      !/NotFound|not found/iu.test(`${existing.stdout}${existing.stderr}`)
    ) {
      throw new Error(
        `[${runnerName}] could not determine whether registry secret ${this.config.registry.secretName} is safe to update`,
      );
    }
    if (existing.exitCode === 0) {
      const labels = JSON.parse(existing.stdout).metadata?.labels;
      if (labels?.[registrySecretOwnerLabel] !== runnerName) {
        throw new Error(
          `[${runnerName}] refusing to overwrite registry secret ${this.config.registry.secretName}: ownership label is absent`,
        );
      }
    }
    await this.kubectl(["apply", "-f", "-"], {
      input: renderRegistrySecret(this.config.namespace, this.config.registry),
    });
  }

  async writeCandidateValues() {
    this.tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rivet-managed-provider-gate-"),
    );
    this.candidateValuesFile = path.join(this.tempDir, "candidate-images.json");
    const values = {
      imagePullSecrets: [{ name: this.config.registry.secretName }],
      images: Object.fromEntries(
        Object.entries(this.config.images).map(([name, image]) => [
          name,
          {
            repository: image.repository,
            digest: image.digest,
            pullPolicy: "Always",
          },
        ]),
      ),
    };
    await fs.writeFile(
      this.candidateValuesFile,
      `${JSON.stringify(values, null, 2)}\n`,
      "utf8",
    );
  }

  async inspectReleaseHistory() {
    const result = await run(
      this.helmBin,
      [
        "history",
        this.config.release,
        "--namespace",
        this.config.namespace,
        "--output",
        "json",
      ],
      { capture: true, allowFailure: true },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      if (/release:\s+not found/iu.test(output)) {
        return { hasHistory: false, deployedRevision: undefined };
      }
      throw new Error(
        `[${runnerName}] could not inspect Helm history for ${this.config.release}: ${output || `exit ${result.exitCode}`}`,
      );
    }
    if (!result.stdout.trim()) {
      throw new Error(
        `[${runnerName}] Helm history for ${this.config.release} returned no data`,
      );
    }
    let history;
    try {
      history = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `[${runnerName}] Helm history for ${this.config.release} did not return JSON`,
      );
    }
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error(
        `[${runnerName}] Helm history for ${this.config.release} did not contain a release revision`,
      );
    }
    const deployed = history
      .filter((entry) => entry.status === "deployed")
      .at(-1);
    return {
      hasHistory: true,
      deployedRevision: Number.isInteger(deployed?.revision)
        ? deployed.revision
        : undefined,
    };
  }

  async upgradeCandidate({ reuseValues = false, setValues = {} } = {}) {
    if (!this.candidateValuesFile)
      throw new Error("Candidate values file was not initialized");
    const args = [
      "upgrade",
      "--install",
      this.config.release,
      "charts",
      "--namespace",
      this.config.namespace,
      "--values",
      this.config.valuesFile,
      "--values",
      this.candidateValuesFile,
      "--atomic",
      "--wait",
      "--wait-for-jobs",
      "--timeout",
      `${this.config.deploymentTimeoutSeconds}s`,
    ];
    if (reuseValues) args.push("--reuse-values");
    for (const [key, value] of Object.entries(setValues))
      args.push("--set-string", `${key}=${value}`);
    await run(this.helmBin, args);
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
    for (const [component, image] of Object.entries(this.config.images)) {
      if (!manifest.stdout.includes(imageReference(image))) {
        throw new Error(
          `[${runnerName}] ${component} manifest did not use the immutable candidate digest`,
        );
      }
    }
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
      ["get", "ingress", "-n", this.config.namespace, "-o", "yaml"],
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

  async verifyIngress() {
    const expectedHost = new URL(this.config.baseUrl).host;
    const result = await this.kubectl(
      [
        "get",
        "ingress",
        "-n",
        this.config.namespace,
        "-l",
        `app.kubernetes.io/instance=${this.config.release}`,
        "-o",
        "json",
      ],
      { capture: true },
    );
    const hasHost = JSON.parse(result.stdout).items?.some((ingress) =>
      ingress.spec?.rules?.some((rule) => rule.host === expectedHost),
    );
    if (!hasHost)
      throw new Error(
        `[${runnerName}] no staging ingress serves ${expectedHost}`,
      );
  }

  async request(
    pathValue,
    { method = "GET", body, expectedStatus = 200, contains } = {},
  ) {
    const response = await fetch(new URL(pathValue, this.config.baseUrl), {
      method,
      headers: {
        accept: "application/json, text/html;q=0.9",
        ...this.config.requestHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `[${runnerName}] ${method} ${pathValue} returned ${response.status}, expected ${expectedStatus}`,
      );
    }
    if (contains && !text.includes(contains)) {
      throw new Error(
        `[${runnerName}] ${method} ${pathValue} did not include the expected response marker`,
      );
    }
    return { response, text };
  }

  async assertPublicHealth() {
    await this.request("/readyz", { expectedStatus: 200 });
  }

  async seedAppSettingsBaseline() {
    if (!this.config.keyRotation) return undefined;
    const existing = await this.request("/api/app-settings/run-recordings");
    const baseline = canonicalJson(existing.text, "Run recordings settings");
    await this.request("/api/app-settings/run-recordings", {
      method: "PATCH",
      body: JSON.parse(existing.text),
    });
    return baseline;
  }

  async assertAppSettingsBaseline(baseline) {
    if (!baseline) return;
    const current = await this.request("/api/app-settings/run-recordings");
    if (canonicalJson(current.text, "Run recordings settings") !== baseline) {
      throw new Error(
        `[${runnerName}] persisted App Settings changed while rotating its encryption key`,
      );
    }
  }

  async runProbe(probe) {
    return this.request(probe.path, probe);
  }

  async assertPublicSurface() {
    await this.assertPublicHealth();
    await this.runProbe(this.config.workflowProbe);
    await this.runProbe(this.config.webAppProbe);
  }

  async validateInterruptionManifest(filePath) {
    await fs.access(filePath);
    const result = await this.kubectl(
      [
        "create",
        "--dry-run=client",
        "--namespace",
        this.config.namespace,
        "--output",
        "json",
        "-f",
        filePath,
      ],
      { capture: true },
    );
    const resources = parseItems(JSON.parse(result.stdout));
    if (
      !resources.length ||
      resources.some(
        (resource) =>
          resource.kind !== "NetworkPolicy" ||
          resource.metadata?.namespace !== this.config.namespace,
      )
    ) {
      throw new Error(
        `[${runnerName}] interruption manifests may contain only NetworkPolicy resources in ${this.config.namespace}`,
      );
    }
  }

  async verifyDependencyInterruptions() {
    for (const interruption of this.config.interruptionManifests) {
      await this.validateInterruptionManifest(interruption.applyFile);
      await this.validateInterruptionManifest(interruption.restoreFile);
      try {
        await this.kubectl([
          "apply",
          "--namespace",
          this.config.namespace,
          "-f",
          interruption.applyFile,
        ]);
        await waitFor(
          `${interruption.name} readiness failure`,
          async () => {
            const response = await fetch(
              new URL("/readyz", this.config.baseUrl),
              {
                headers: this.config.requestHeaders,
                signal: AbortSignal.timeout(10_000),
              },
            );
            if (response.ok)
              throw new Error("expected the staging runtime to become unready");
            return response;
          },
          90_000,
        );
      } finally {
        await this.kubectl([
          interruption.restoreAction,
          "--namespace",
          this.config.namespace,
          "-f",
          interruption.restoreFile,
        ]);
      }
      await waitFor(
        `${interruption.name} readiness recovery`,
        async () => this.assertPublicHealth(),
        180_000,
      );
      await this.assertPublicSurface();
    }
  }

  getFinalAppSettingsKeyValues() {
    const rotation = this.config.keyRotation;
    if (!rotation) return {};
    return {
      "appSettings.encryptionKeySecretName": rotation.nextSecretName,
      "appSettings.encryptionKeySecretKey": rotation.secretKey,
      "appSettings.previousEncryptionKeySecretName": "",
    };
  }

  async rotateAppSettingsKey(appSettingsBaseline) {
    const rotation = this.config.keyRotation;
    if (!rotation) return;
    const phases = [
      {
        primary: rotation.currentSecretName,
        previous: rotation.nextSecretName,
      },
      {
        primary: rotation.nextSecretName,
        previous: rotation.currentSecretName,
      },
      { primary: rotation.nextSecretName, previous: "" },
    ];
    for (const phase of phases) {
      await this.upgradeCandidate({
        reuseValues: true,
        setValues: {
          "appSettings.encryptionKeySecretName": phase.primary,
          "appSettings.encryptionKeySecretKey": rotation.secretKey,
          "appSettings.previousEncryptionKeySecretName": phase.previous,
        },
      });
      await this.assertPublicSurface();
      await this.assertAppSettingsBaseline(appSettingsBaseline);
    }
  }

  async verifyLegacyImportAndRollback(previousRevision) {
    const legacyImport = this.config.legacyImport;
    if (!legacyImport) return;
    if (!previousRevision) {
      throw new Error(
        `[${runnerName}] legacy import verification requires a pre-existing deployed ${this.config.release} release`,
      );
    }
    await this.runProbe(legacyImport.probe);
    await run(this.helmBin, [
      "rollback",
      this.config.release,
      String(previousRevision),
      "--namespace",
      this.config.namespace,
      "--wait",
      "--wait-for-jobs",
      "--timeout",
      `${this.config.deploymentTimeoutSeconds}s`,
    ]);
    await this.assertPublicHealth();
    await this.runProbe(legacyImport.probe);
    await this.upgradeCandidate({
      reuseValues: true,
      setValues: this.getFinalAppSettingsKeyValues(),
    });
    await this.assertPublicSurface();
    await this.runProbe(legacyImport.probe);
  }

  async close() {
    if (this.tempDir)
      await fs.rm(this.tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const config = buildManagedProviderGateConfig({ rootDir });
  const gate = new ManagedProviderGate(
    config,
    resolveKubectlBin(process.env),
    resolveHelmBinOrThrow(rootDir, {
      env: process.env,
      launcherName: runnerName,
    }),
  );
  let releaseHistory;
  await fs.mkdir(config.artifactsDir, { recursive: true });
  await gate.artifact(
    "config.json",
    `${JSON.stringify(
      {
        context: config.context,
        namespace: config.namespace,
        release: config.release,
        baseUrl: config.baseUrl,
        images: Object.fromEntries(
          Object.entries(config.images).map(([name, image]) => [
            name,
            imageReference(image),
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  try {
    await gate.assertContext();
    releaseHistory = await gate.inspectReleaseHistory();
    await gate.createRegistrySecret();
    await gate.writeCandidateValues();
    await gate.upgradeCandidate({
      reuseValues: releaseHistory.hasHistory,
    });
    await gate.verifyIngress();
    await gate.assertPublicSurface();
    const appSettingsBaseline = await gate.seedAppSettingsBaseline();
    await gate.rotateAppSettingsKey(appSettingsBaseline);
    await gate.verifyDependencyInterruptions();
    await gate.verifyLegacyImportAndRollback(releaseHistory.deployedRevision);
    await gate.capture("success");
    console.log(`[${runnerName}] provider staging gate passed`);
  } catch (error) {
    try {
      await gate.capture("failure");
    } catch (captureError) {
      console.error(`[${runnerName}] artifact capture failed:`, captureError);
    }
    throw error;
  } finally {
    await gate.close();
  }
}

await main();
