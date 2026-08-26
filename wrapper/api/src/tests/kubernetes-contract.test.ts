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
  assert.match(
    renderedChart,
    /name: RIVET_EXECUTION_ENVIRONMENT_API_URL\s*\n\s*value: "http:\/\/127\.0\.0\.1:8080\/api\/workflows\/execution-environment"/,
  );
  assert.match(renderedChart, /initContainers:\s*\n\s*- name: deployment-storage-settings/);
  assert.match(renderedChart, /node \/opt\/rivet\/lib\/bootstrap-deployment-storage-settings\.mjs/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_STORAGE_MODE\s*\n\s*value: "managed"/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID/);
  assert.equal(
    (renderedChart.match(/\s+name: app-data\s*\n\s*emptyDir: \{\}/g) ?? []).length,
    2,
    'control and execution pods should use separate pod-local app-data volumes',
  );
  assert.equal(
    (renderedChart.match(/- name: managed-app-settings-projection/g) ?? []).length,
    2,
    'control and execution pods should project managed settings before containers start',
  );
  assert.match(renderedChart, /project-managed-app-settings\.js/);
  assert.match(renderedChart, /name: RIVET_APP_SETTINGS_BACKEND\s*\n\s*value: "postgres"/);
  assert.match(renderedChart, /name: RIVET_PROXY_SETTINGS_URL\s*\n\s*value: "http:\/\/[^\"]+\/internal\/app-settings\/proxy-config"/);
  assert.doesNotMatch(renderedChart, /rivet-local-app-data|persistentVolumeClaim:[\s\S]{0,80}name: app-data/);
  assert.doesNotMatch(readRepoFile('charts/templates/proxy-deployment.yaml'), /mountPath: \/data\/rivet-app|name: app-data/);
  assert.doesNotMatch(renderedChart, /name: RIVET_STORAGE_MODE\b|name: RIVET_DATABASE_MODE\b|name: RIVET_DATABASE_CONNECTION_STRING\b|name: RIVET_STORAGE_ACCESS_KEY_ID\b/);
  assert.doesNotMatch(renderedChart, /RIVET_WEB_APPS_AUTH_MODE|OAUTH_CLIENT_SECRET|OAUTH_AUTHORIZE_URL/);
});

test('chart serializes managed workflow migrations before verify-only API workloads start', async () => {
  const renderedChart = await renderLocalKubernetesChart();
  const migrationJobDocument = renderedChart
    .split('# Source: rivet/templates/workflow-schema-migration-job.yaml')[1]
    ?.split('\n---\n')[0];
  const chartHelpers = readRepoFile('charts/templates/_helpers.tpl');
  const migrationJobTemplate = readRepoFile('charts/templates/workflow-schema-migration-job.yaml');

  assert.ok(migrationJobDocument, 'rendered chart should contain the workflow schema migration Job');

  assert.match(
    renderedChart,
    /kind: Job[\s\S]*?app\.kubernetes\.io\/component: workflow-schema-migration/,
  );
  assert.match(renderedChart, /helm\.sh\/hook: pre-install,pre-upgrade/);
  assert.match(renderedChart, /helm\.sh\/hook-delete-policy: before-hook-creation,hook-succeeded/);
  assert.match(migrationJobTemplate, /include "rivet\.vaultAnnotations"/);
  assert.match(chartHelpers, /vault\.hashicorp\.com\/agent-pre-populate-only: "true"/);
  assert.match(
    renderedChart,
    /bootstrap-deployment-storage-settings\.mjs; RIVET_APP_SETTINGS_BACKEND=file node --preserve-symlinks \/app\/wrapper\/api\/dist\/api\/src\/scripts\/migrate-managed-workflow-schema\.js migrate; node --preserve-symlinks \/app\/wrapper\/api\/dist\/api\/src\/scripts\/import-managed-app-settings\.js/,
  );
  assert.match(
    migrationJobDocument,
    /name: RIVET_APP_DATA_ROOT\s*\n\s*value: "\/var\/tmp\/rivet-migration-app-data"/,
  );
  const migrationEnvironmentNames = [
    ...migrationJobDocument.matchAll(/^\s+- name: (RIVET_[A-Z0-9_]+)\s*$/gm),
  ].map((match) => match[1]);
  assert.equal(
    new Set(migrationEnvironmentNames).size,
    migrationEnvironmentNames.length,
    'the migration Job must not declare duplicate Rivet environment variables',
  );
  assert.doesNotMatch(migrationJobDocument, /persistentVolumeClaim:|claimName:|mountPath: \/data\/rivet-app/);
  assert.match(
    renderedChart,
    /app\.kubernetes\.io\/component: workflow-schema-migration[\s\S]*?name: RIVET_BUILD_VERSION\s*\n\s*value: "rivet-local\/api:dev"/,
  );
  assert.match(
    renderedChart,
    /app\.kubernetes\.io\/component: workflow-schema-migration[\s\S]*?name: migrate[\s\S]*?resources:\s*\n\s*\{\}/,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE\s*\n\s*value: verify/g) ?? []).length,
    2,
    'control and execution API pods must verify the schema instead of mutating it',
  );
  assert.match(
    readRepoFile('image/api/entrypoint.sh'),
    /deployment_managed_workflow_schema_mode="\$\{RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE:-\}"[\s\S]*load_optional_dotenv \/vault\/dotenv[\s\S]*RIVET_MANAGED_WORKFLOW_SCHEMA_MODE="\$deployment_managed_workflow_schema_mode"/,
  );
});

test('chart can delegate migration execution but never lets API replicas become schema writers', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    'workflowSchema.migrationJob.enabled=false',
  ]);

  assert.doesNotMatch(renderedChart, /app\.kubernetes\.io\/component: workflow-schema-migration/);
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE\s*\n\s*value: verify/g) ?? []).length,
    2,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_MANAGED_WORKFLOW_SCHEMA_MODE=migrate'],
    /env\.RIVET_MANAGED_WORKFLOW_SCHEMA_MODE is chart-owned/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE=migrate'],
    /internal chart-owned startup policy/,
  );
});

test('chart validation keeps the supported managed singleton control-plane boundaries', () => {
  const validateValuesTemplate = readRepoFile('charts/templates/validate-values.yaml');

  assert.match(validateValuesTemplate, /workflowStorage\.backend=managed and runtimeLibraries\.backend=managed/);
  assert.match(validateValuesTemplate, /replicaCount\.backend=1 is required because \/ws\/latest-debugger and co-located editor executor session routing remain process-local control-plane features/);
  assert.match(validateValuesTemplate, /autoscaling\.backend\.enabled=false is required because \/ws\/latest-debugger and co-located editor executor session routing remain process-local control-plane features/);
  assert.match(validateValuesTemplate, /appSettings\.backend=postgres so settings remain consistent across replicas without a shared app-data volume/);
});

test('chart renders profile-aware probes, graceful lifecycle, and replicated-tier availability policies', async () => {
  const renderedChart = await renderLocalKubernetesChart();

  assert.equal((renderedChart.match(/path: \/readyz/g) ?? []).length, 2);
  assert.equal((renderedChart.match(/path: \/livez/g) ?? []).length, 4);
  assert.equal((renderedChart.match(/startupProbe:/g) ?? []).length, 5);
  assert.equal((renderedChart.match(/livenessProbe:/g) ?? []).length, 5);
  assert.equal((renderedChart.match(/readinessProbe:/g) ?? []).length, 5);
  assert.equal((renderedChart.match(/name: RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS\s*\n\s*value: "120"/g) ?? []).length, 2);
  assert.equal((renderedChart.match(/name: RIVET_DEPLOYMENT_HEALTH_REFRESH_SECONDS\s*\n\s*value: "5"/g) ?? []).length, 2);
  assert.equal((renderedChart.match(/name: RIVET_DEPLOYMENT_HEALTH_CHECK_TIMEOUT_SECONDS\s*\n\s*value: "3"/g) ?? []).length, 2);
  assert.equal((renderedChart.match(/name: RIVET_DEPLOYMENT_HEALTH_STALE_AFTER_SECONDS\s*\n\s*value: "20"/g) ?? []).length, 2);
  assert.equal((renderedChart.match(/terminationGracePeriodSeconds: 150/g) ?? []).length, 4);
  assert.equal((renderedChart.match(/command: \["\/bin\/sh", "-c", "sleep 5"\]/g) ?? []).length, 5);
  assert.equal((renderedChart.match(/type: RollingUpdate/g) ?? []).length, 4);
  assert.equal((renderedChart.match(/maxUnavailable: 0/g) ?? []).length, 3);
  assert.equal((renderedChart.match(/topologySpreadConstraints:/g) ?? []).length, 4);
  assert.equal((renderedChart.match(/preferredDuringSchedulingIgnoredDuringExecution:/g) ?? []).length, 4);
  assert.equal((renderedChart.match(/kind: PodDisruptionBudget/g) ?? []).length, 2);
  const disruptionBudgets = renderedChart
    .split(/^---$/m)
    .filter((document) => document.includes('kind: PodDisruptionBudget'))
    .join('\\n---\\n');
  assert.match(renderedChart, /kind: PodDisruptionBudget[\s\S]*?app\.kubernetes\.io\/component: proxy/);
  assert.match(renderedChart, /kind: PodDisruptionBudget[\s\S]*?app\.kubernetes\.io\/component: execution/);
  assert.doesNotMatch(disruptionBudgets, /app\.kubernetes\.io\/component: backend/);

  await assertHelmTemplateFails(
    ['lifecycle.terminationGracePeriodSeconds=149'],
    /must allow shutdownGraceSeconds, preStopDelaySeconds, and a 25-second finalization margin/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_SHUTDOWN_GRACE_SECONDS=10'],
    /env\.RIVET_SHUTDOWN_GRACE_SECONDS is chart-owned/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS=10'],
    /env\.RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS is chart-owned/,
  );
  await assertHelmTemplateFails(
    ['lifecycle.probes.readiness.periodSeconds=0'],
    /lifecycle\.probes\.readiness periodSeconds, timeoutSeconds, and failureThreshold must be greater than zero/,
  );
  await assertHelmTemplateFails(
    ['availability.disruptionBudget.maxUnavailable=2'],
    /must be less than the effective minimum replica count for proxy/,
  );
});
test('production overlay keeps the supported ingress, Vault, and scale boundaries for the real cluster topology', () => {
  const prodOverlay = readRepoFile('charts/overlays/prod.yaml');

  assert.match(prodOverlay, /ingress:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /vault:\s*\n\s*enabled:\s*true/);
  assert.match(prodOverlay, /backend:\s*1/);
  assert.match(prodOverlay, /web:\s*1/);
  assert.match(prodOverlay, /execution:\s*[2-9]\d*/);
  assert.match(prodOverlay, /workflowStorage:\s*\n\s*backend:\s*managed/);
  assert.doesNotMatch(prodOverlay, /rivet-prod-app-data|storage:\s*\n\s*appData:/);
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
  assert.match(localOverlay, /workflowStorage:\s*\n\s*backend:\s*managed/);
  assert.doesNotMatch(localOverlay, /rivet-local-app-data|storage:\s*\n\s*appData:/);
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

test('chart forwards arbitrary runtime credentials without a provider-specific template list', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    'env.BILLING_OPENAI_KEY=chart-test-secret',
  ]);

  assert.equal(
    (renderedChart.match(/name: BILLING_OPENAI_KEY\s*\n\s*value: "chart-test-secret"/g) ?? []).length,
    3,
    'only the control API, execution API, and editor executor should receive arbitrary runtime credentials',
  );
  assert.match(readRepoFile('charts/templates/proxy-deployment.yaml'), /include "rivet\.env\.proxyValues"/);
  assert.match(readRepoFile('charts/templates/proxy-deployment.yaml'), /include "rivet\.vaultProxyAnnotations"/);
  assert.match(readRepoFile('charts/templates/_helpers.tpl'), /RIVET_KEY=\{\{ "\{\{ \.Data\.data\.RIVET_KEY \| toJSON \}\}" \}\}/);
  assert.doesNotMatch(readRepoFile('charts/templates/_env.tpl'), /OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY/);
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
    ['appSettings.backend=file'],
    /appSettings\.backend=postgres so settings remain consistent across replicas without a shared app-data volume/,
  );
});
