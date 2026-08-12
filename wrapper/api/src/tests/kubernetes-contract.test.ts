import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readRepoFile,
  repoRoot,
} from './helpers/repo-contract-helpers.js';

type K8sToolsModule = {
  resolveHelmBinOrThrow(rootDir: string, options?: { env?: NodeJS.ProcessEnv; launcherName?: string }): string;
};

async function resolveHelmBin(): Promise<string> {
  const moduleUrl = new URL('../../../../scripts/lib/k8s-tools.mjs', import.meta.url);
  const { resolveHelmBinOrThrow } = await import(moduleUrl.href) as K8sToolsModule;
  return resolveHelmBinOrThrow(repoRoot, { env: process.env, launcherName: 'kubernetes-contract' });
}

async function renderLocalKubernetesChart(): Promise<string> {
  return renderLocalKubernetesChartWithOverrides([]);
}

async function renderLocalKubernetesChartWithOverrides(overrides: string[]): Promise<string> {
  return execFileSync(
    await resolveHelmBin(),
    [
      'template',
      'rivet',
      'charts',
      '-f',
      'charts/overlays/local-kubernetes.yaml',
      '--set',
      'objectStorage.bucket=test-bucket',
      ...overrides.flatMap((override) => ['--set', override]),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
}

async function assertHelmTemplateFails(overrides: string[], expectedMessage: RegExp): Promise<void> {
  const helmBin = await resolveHelmBin();
  const args = [
    'template',
    'rivet',
    'charts',
    '-f',
    'charts/overlays/local-kubernetes.yaml',
    '--set',
    'objectStorage.bucket=test-bucket',
    ...overrides.flatMap((override) => ['--set', override]),
  ];

  assert.throws(
    () => execFileSync(helmBin, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }),
    (error: unknown) => {
      const stderr = typeof error === 'object' && error != null && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr)
        : '';
      const message = error instanceof Error ? error.message : String(error);
      assert.match(`${stderr}\n${message}`, expectedMessage);
      return true;
    },
  );
}

test('rendered chart keeps control-plane and execution-plane API env contracts distinct', async () => {
  const renderedChart = await renderLocalKubernetesChart();

  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "control"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s*\n\s*value: "none"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s*\n\s*value: "true"/,
  );
  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "execution"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s*\n\s*value: "endpoint"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s*\n\s*value: "false"/,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_RUNNER_SLOT_ID\s*\n\s*valueFrom:\s*\n\s*fieldRef:\s*\n\s*fieldPath: metadata\.name/g) ?? []).length,
    2,
    'control and execution API pods need distinct stable action-run slots',
  );
  assert.match(renderedChart, /name: RIVET_WEB_UPSTREAM_HOST[\s\S]*svc\.cluster\.local/);
  assert.match(renderedChart, /name: RIVET_API_UPSTREAM_HOST[\s\S]*svc\.cluster\.local/);
  assert.match(renderedChart, /name: RIVET_EXECUTION_UPSTREAM_HOST[\s\S]*svc\.cluster\.local/);
  assert.match(renderedChart, /name: RIVET_EXECUTOR_UPSTREAM_HOST[\s\S]*svc\.cluster\.local/);
  assert.match(
    renderedChart,
    /name: RIVET_LLM_PROFILE_HEALTH_API_URL\s*\n\s*value: "http:\/\/127\.0\.0\.1:8080\/api\/workflows\/llm-profile-health"/,
  );
  assert.match(renderedChart, /initContainers:\s*\n\s*- name: deployment-storage-settings/);
  assert.match(renderedChart, /node \/opt\/rivet\/lib\/bootstrap-deployment-storage-settings\.mjs/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_STORAGE_MODE\s*\n\s*value: "managed"/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID/);
  assert.ok(
    (renderedChart.match(/\s+name: app-data\s*\n\s*persistentVolumeClaim:\s*\n\s*claimName: "?rivet-local-app-data"?/g) ?? []).length >= 3,
    'backend, proxy, and execution workloads should all mount the shared app-data claim',
  );
  assert.doesNotMatch(renderedChart, /name: RIVET_STORAGE_MODE\b|name: RIVET_DATABASE_MODE\b|name: RIVET_DATABASE_CONNECTION_STRING\b|name: RIVET_STORAGE_ACCESS_KEY_ID\b/);
  assert.doesNotMatch(renderedChart, /RIVET_WEB_APPS_AUTH_MODE|OAUTH_CLIENT_SECRET|OAUTH_AUTHORIZE_URL/);
});

test('chart validation keeps the supported managed singleton control-plane boundaries', () => {
  const validateValuesTemplate = readRepoFile('charts/templates/validate-values.yaml');

  assert.match(validateValuesTemplate, /workflowStorage\.backend=managed and runtimeLibraries\.backend=managed/);
  assert.match(validateValuesTemplate, /replicaCount\.backend=1 because latest workflow execution, latest web-app action execution, and \/ws\/latest-debugger are still process-local control-plane features/);
  assert.match(validateValuesTemplate, /autoscaling\.backend\.enabled=false because latest workflow execution, latest web-app action execution, and \/ws\/latest-debugger are still process-local control-plane features/);
  assert.match(validateValuesTemplate, /storage\.appData\.existingClaimName is required so backend, execution, executor, and proxy pods share UI-managed app settings/);
});

test('production overlay keeps the supported ingress, Vault, and scale boundaries for the real cluster topology', () => {
  const prodOverlay = readRepoFile('charts/overlays/prod.yaml');

  assert.match(prodOverlay, /ingress:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /vault:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /backend:\s*1/);
  assert.match(prodOverlay, /web:\s*1/);
  assert.match(prodOverlay, /execution:\s*[2-9]\d*/);
  assert.match(prodOverlay, /existingClaimName:\s*rivet-prod-app-data/);
  assert.match(prodOverlay, /autoscaling:[\s\S]*proxy:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /autoscaling:[\s\S]*web:\s*\n\s*enabled:\s*false/);
  assert.match(prodOverlay, /autoscaling:[\s\S]*backend:\s*\n\s*enabled:\s*false/);
  assert.match(prodOverlay, /autoscaling:[\s\S]*execution:\s*\n\s*enabled:\s*true/);
});

test('local Kubernetes overlay keeps the backend singleton while scaling endpoint-serving tiers and enabling latest debugger support', () => {
  const localOverlay = readRepoFile('charts/overlays/local-kubernetes.yaml');

  for (const service of ['proxy', 'web', 'api', 'executor']) {
    assert.match(localOverlay, new RegExp(`repository:\\s*rivet-local\\/${service}`));
  }
  assert.match(localOverlay, /backend:\s*1/);
  assert.match(localOverlay, /web:\s*1/);
  assert.match(localOverlay, /execution:\s*2/);
  assert.match(localOverlay, /existingClaimName:\s*rivet-local-app-data/);
  assert.match(localOverlay, /RIVET_ENABLE_LATEST_REMOTE_DEBUGGER:\s*"true"/);
  assert.doesNotMatch(localOverlay, /RIVET_REQUIRE_WORKFLOW_KEY/);
  assert.match(localOverlay, /RIVET_REQUIRE_UI_GATE_KEY:\s*"false"/);
  assert.doesNotMatch(localOverlay, /RIVET_WEB_APPS_AUTH_MODE|OAUTH_CLIENT_SECRET|OAUTH_AUTHORIZE_URL/);
});

test('local Kubernetes launcher builds Rivet-dependent images from the filtered Rivet source context', () => {
  const kubernetesLauncher = readRepoFile('scripts/dev-kubernetes.mjs');

  assert.match(kubernetesLauncher, /prepareRivetDockerContext\(rootDir, env\)/);
  assert.match(kubernetesLauncher, /needsRivetSource: true/);
  assert.match(kubernetesLauncher, /--build-context/);
  assert.match(kubernetesLauncher, /rivet_source=\$\{rivetSourceBuildContextPath\}/);
  assert.match(kubernetesLauncher, /rivet_dependency_metadata=\$\{rivetDependencyBuildContextPath\}/);
});

test('executor app-data path remains intentionally separate from API app-data mounts', () => {
  const podPartials = readRepoFile('charts/templates/_pod.tpl');

  assert.match(
    podPartials,
    /The executor keeps the Rivet desktop-app storage layout on purpose\.\s*\n# Do not unify this mount path with the API app-data mount\./,
  );
  assert.match(podPartials, /mountPath: \/home\/rivet\/\.local\/share\/com\.valerypopoff\.rivet2/);
});

test('chart renders custom public route env defaults as bootstrap values', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    'env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/custom-workflows',
    'env.RIVET_LATEST_WORKFLOWS_BASE_PATH=/custom-workflows-latest',
    'env.RIVET_PUBLISHED_APPS_BASE_PATH=/custom-apps',
    'env.RIVET_LATEST_APPS_BASE_PATH=/custom-apps-latest',
  ]);

  assert.match(renderedChart, /name: RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\s*\n\s*value: "\/custom-workflows"/);
  assert.match(renderedChart, /name: RIVET_LATEST_WORKFLOWS_BASE_PATH\s*\n\s*value: "\/custom-workflows-latest"/);
  assert.match(renderedChart, /name: RIVET_PUBLISHED_APPS_BASE_PATH\s*\n\s*value: "\/custom-apps"/);
  assert.match(renderedChart, /name: RIVET_LATEST_APPS_BASE_PATH\s*\n\s*value: "\/custom-apps-latest"/);
});

test('chart validation rejects placeholder images and unsupported filesystem topology', async () => {
  await assertHelmTemplateFails(
    ['images.api.repository=example.invalid/api'],
    /replace the example\.invalid image repositories with real image repositories before install/,
  );
  await assertHelmTemplateFails(
    [
      'workflowStorage.backend=filesystem',
      'runtimeLibraries.backend=filesystem',
      'filesystem.workflows.existingClaimName=workflows-pvc',
      'filesystem.runtimeLibraries.existingClaimName=runtime-libraries-pvc',
    ],
    /workflowStorage\.backend=managed and runtimeLibraries\.backend=managed/,
  );
  await assertHelmTemplateFails(
    ['storage.appData.existingClaimName='],
    /storage\.appData\.existingClaimName is required so backend, execution, executor, and proxy pods share UI-managed app settings/,
  );
});
