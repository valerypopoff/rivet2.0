import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

import { readRepoFile, repoRoot } from './helpers/repo-contract-helpers.js';

type K8sToolsModule = {
  resolveHelmBinOrThrow(rootDir: string, options?: { env?: NodeJS.ProcessEnv; launcherName?: string }): string;
};

async function resolveHelmBin(): Promise<string> {
  const moduleUrl = new URL('../../../../deploy/studio-server/scripts/lib/k8s-tools.mjs', import.meta.url);
  const { resolveHelmBinOrThrow } = (await import(moduleUrl.href)) as K8sToolsModule;
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
      'deploy/studio-server/helm',
      '-f',
      'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
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

async function assertHelmTemplateFails(
  overrides: string[],
  expectedMessage: RegExp,
  overrideFlag: '--set' | '--set-json' = '--set',
): Promise<void> {
  const helmBin = await resolveHelmBin();
  const args = [
    'template',
    'rivet',
    'deploy/studio-server/helm',
    '-f',
    'deploy/studio-server/helm/overlays/local-kubernetes.yaml',
    '--set',
    'objectStorage.bucket=test-bucket',
    ...overrides.flatMap((override) => [overrideFlag, override]),
  ];

  assert.throws(
    () => execFileSync(helmBin, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }),
    (error: unknown) => {
      const stderr =
        typeof error === 'object' && error != null && 'stderr' in error
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
    /name: RIVET_API_PROFILE\s*\n\s*value: "control"\s*\n\s*- name: RIVET_DEPLOYMENT_TOPOLOGY\s*\n\s*value: "replicated"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s*\n\s*value: "none"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s*\n\s*value: "true"/,
  );
  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "execution"\s*\n\s*- name: RIVET_DEPLOYMENT_TOPOLOGY\s*\n\s*value: "replicated"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s*\n\s*value: "endpoint"[\s\S]*?- name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s*\n\s*value: "false"/,
  );
  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "control"[\s\S]*?name: RIVET_MANAGED_MAINTENANCE_ENABLED\s*\n\s*value: "true"[\s\S]*?name: RIVET_MANAGED_MAINTENANCE_INTERVAL_MS\s*\n\s*value: "300000"[\s\S]*?name: RIVET_MANAGED_MAINTENANCE_LEASE_MS\s*\n\s*value: "60000"[\s\S]*?name: RIVET_MANAGED_MAINTENANCE_BATCH_SIZE\s*\n\s*value: "100"[\s\S]*?name: RIVET_MANAGED_EVALUATION_RETENTION_MODE\s*\n\s*value: "audit"/,
    'only the singleton control-plane API pod may schedule global managed maintenance',
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE\s*\n\s*value: "audit"/g) ?? []).length,
    2,
    'all API workloads receive one chart-owned audit-first stale-upload policy',
  );
  assert.match(
    renderedChart,
    /name: RIVET_MANAGED_STALE_UPLOAD_RETENTION_MINIMUM_CANDIDATE_AGE_HOURS\s*\n\s*value: "24"[\s\S]*?name: RIVET_MANAGED_STALE_UPLOAD_RETENTION_REQUIRED_COMPLETED_SCANS\s*\n\s*value: "2"/,
  );
  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "execution"[\s\S]*?name: RIVET_MANAGED_MAINTENANCE_ENABLED\s*\n\s*value: "false"/,
    'endpoint-serving replicas must never each schedule global managed maintenance',
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_HOSTED_EVALUATIONS_ENABLED\s*\n\s*value: "false"/g) ?? []).length,
    2,
    'hosted Evaluation dispatch stays explicitly disabled until the managed execution tier is provisioned for it',
  );
  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "execution"[\s\S]*?name: RIVET_HOSTED_EVALUATIONS_WORKER_CONCURRENCY\s*\n\s*value: "1"[\s\S]*?name: RIVET_HOSTED_EVALUATIONS_LEASE_MS\s*\n\s*value: "60000"[\s\S]*?name: RIVET_HOSTED_EVALUATIONS_POLL_MS\s*\n\s*value: "1000"/,
    'execution pods receive the bounded hosted Evaluation scheduler policy',
  );
  assert.equal(
    (
      renderedChart.match(
        /name: RIVET_RUNNER_SLOT_ID\s*\n\s*valueFrom:\s*\n\s*fieldRef:\s*\n\s*fieldPath: metadata\.name/g,
      ) ?? []
    ).length,
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
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_DATABASE_POOL_MAX\s*\n\s*value: "10"/);
  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID/);
  const boundedWritableVolumes = [
    ['workspace', '2Gi', 2],
    ['workflows', '2Gi', 2],
    ['app-data', '1Gi', 2],
    ['runtime-libraries', '8Gi', 2],
    ['var-tmp', '2Gi', 4],
  ] as const;
  for (const [volumeName, sizeLimit, expectedOccurrences] of boundedWritableVolumes) {
    assert.equal(
      (
        renderedChart.match(
          new RegExp(`- name: ${volumeName}\\s*\\n\\s*emptyDir:\\s*\\n\\s*sizeLimit: ${sizeLimit}`, 'g'),
        ) ?? []
      ).length,
      expectedOccurrences,
      `${volumeName} should have a bounded emptyDir wherever the local managed topology creates it`,
    );
  }
  assert.doesNotMatch(
    renderedChart,
    /emptyDir: \{\}/,
    'the managed local render must not leave writable emptyDirs unbounded',
  );
  const initContainersWithResources =
    renderedChart.match(
      /- name: (?:deployment-storage-settings|managed-app-settings-projection)[\s\S]*?resources:\s*\n\s*requests:/g,
    ) ?? [];
  assert.equal(
    initContainersWithResources.length,
    4,
    'every managed-storage init container should inherit the owning workload resource policy',
  );
  assert.equal(
    (renderedChart.match(/- name: managed-app-settings-projection/g) ?? []).length,
    2,
    'control and execution pods should project managed settings before containers start',
  );
  const projectionEnvironmentBlocks = [
    ...renderedChart.matchAll(
      /- name: managed-app-settings-projection[\s\S]*?\n\s+env:\s*\n([\s\S]*?)\n\s+volumeMounts:/g,
    ),
  ].map((match) => match[1]);
  assert.equal(projectionEnvironmentBlocks.length, 2);
  for (const environmentBlock of projectionEnvironmentBlocks) {
    const environmentNames = [...environmentBlock.matchAll(/^\s+- name: (RIVET_[A-Z0-9_]+)\s*$/gm)].map(
      (match) => match[1],
    );
    assert.equal(
      new Set(environmentNames).size,
      environmentNames.length,
      'managed settings projection must not declare duplicate Rivet environment variables',
    );
  }
  assert.match(renderedChart, /project-managed-app-settings\.js/);
  assert.match(renderedChart, /name: RIVET_APP_SETTINGS_BACKEND\s*\n\s*value: "postgres"/);
  assert.match(
    renderedChart,
    /name: RIVET_PROXY_SETTINGS_URL\s*\n\s*value: "http:\/\/[^\"]+\/internal\/app-settings\/proxy-config"/,
  );
  assert.doesNotMatch(renderedChart, /rivet-local-app-data|persistentVolumeClaim:[\s\S]{0,80}name: app-data/);
  assert.doesNotMatch(
    readRepoFile('deploy/studio-server/helm/templates/proxy-deployment.yaml'),
    /mountPath: \/data\/rivet-app|name: app-data/,
  );
  assert.doesNotMatch(
    renderedChart,
    /name: RIVET_STORAGE_MODE\b|name: RIVET_DATABASE_MODE\b|name: RIVET_DATABASE_CONNECTION_STRING\b|name: RIVET_STORAGE_ACCESS_KEY_ID\b/,
  );
  assert.doesNotMatch(renderedChart, /RIVET_WEB_APPS_AUTH_MODE|OAUTH_CLIENT_SECRET|OAUTH_AUTHORIZE_URL/);
});

test('chart isolates hosted Evaluation workers with chart-owned quotas and a dedicated internal Service', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    'hostedEvaluations.enabled=true',
    'metrics.enabled=true',
    'metrics.serviceMonitor.enabled=true',
  ]);

  assert.match(
    renderedChart,
    /app\.kubernetes\.io\/component: evaluation[\s\S]*?name: RIVET_API_PROFILE\s*\n\s*value: "evaluation"[\s\S]*?name: RIVET_HOSTED_EVALUATIONS_MAX_JOBS_PER_RUN\s*\n\s*value: "2000"[\s\S]*?name: RIVET_HOSTED_EVALUATIONS_MAX_OUTSTANDING_JOBS\s*\n\s*value: "10000"/,
  );
  assert.match(
    renderedChart,
    /app\.kubernetes\.io\/component: evaluation[\s\S]*?name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER\s*\n\s*value: "endpoint"[\s\S]*?name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED\s*\n\s*value: "false"/,
  );
  assert.match(
    renderedChart,
    /kind: Service[\s\S]*?name: rivet-rivet-evaluation[\s\S]*?app\.kubernetes\.io\/component: evaluation/,
  );
  assert.match(
    renderedChart,
    /name: rivet-rivet-evaluation-metrics[\s\S]*?app\.kubernetes\.io\/component: evaluation[\s\S]*?path: \/metrics/,
  );
  assert.doesNotMatch(
    renderedChart,
    /name: RIVET_EVALUATION_UPSTREAM_HOST/,
    'the public proxy must not receive an Evaluation-worker upstream',
  );

  await assertHelmTemplateFails(
    ['hostedEvaluations.workerConcurrency=0'],
    /hostedEvaluations\.workerConcurrency must be an integer between 1 and 8/,
  );
  await assertHelmTemplateFails(
    ['hostedEvaluations.leaseMs=14000'],
    /hostedEvaluations\.leaseMs must be an integer between 15000 and 600000/,
  );
  await assertHelmTemplateFails(
    ['hostedEvaluations.maxJobsPerRun=0'],
    /hostedEvaluations\.maxJobsPerRun must be an integer between 1 and 100000/,
  );
  await assertHelmTemplateFails(
    ['hostedEvaluations.maxJobsPerRun=20', 'hostedEvaluations.maxOutstandingJobs=19'],
    /hostedEvaluations\.maxOutstandingJobs must be an integer between maxJobsPerRun and 1000000/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_HOSTED_EVALUATIONS_ENABLED=true'],
    /env\.RIVET_HOSTED_EVALUATIONS_ENABLED is chart-owned; configure hostedEvaluations instead/,
  );
  await assertHelmTemplateFails(
    ['hostedEvaluations.enabled=true', 'replicaCount.evaluation=0'],
    /hostedEvaluations\.enabled requires replicaCount\.evaluation >= 1/,
  );
});

test('chart owns the published execution admission policy only on execution API pods', async () => {
  const renderedChart = await renderLocalKubernetesChart();
  const apiEntrypoint = readRepoFile('deploy/studio-server/images/api/entrypoint.sh');
  const validationTemplate = readRepoFile('deploy/studio-server/helm/templates/validate-values.yaml');
  const productionOverlay = readRepoFile('deploy/studio-server/helm/overlays/prod.yaml');

  assert.match(
    renderedChart,
    /name: RIVET_API_PROFILE\s*\n\s*value: "execution"[\s\S]*?name: RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_ADMISSION_MODE\s*\n\s*value: "disabled"[\s\S]*?name: RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS\s*\n\s*value: "4"[\s\S]*?name: RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS\s*\n\s*value: "1"/,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_ADMISSION_MODE/g) ?? []).length,
    1,
    'only the execution API pod should receive the public admission policy',
  );
  assert.match(
    productionOverlay,
    /publishedExecutionAdmission:\s*\n\s*mode: enforce\s*\n\s*maxActiveRunsPerPod: 4\s*\n\s*retryAfterSeconds: 1/,
  );
  assert.match(
    validationTemplate,
    /RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE[\s\S]*configure publishedExecutionAdmission instead/,
  );
  assert.match(
    apiEntrypoint,
    /deployment_published_execution_admission_mode="\$\{RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_ADMISSION_MODE:-\}"[\s\S]*load_optional_dotenv \/vault\/dotenv[\s\S]*RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE "\$deployment_published_execution_admission_mode"/,
  );

  await assertHelmTemplateFails(
    ['publishedExecutionAdmission.mode=queue'],
    /publishedExecutionAdmission\.mode must be disabled, observe, or enforce/,
  );
  await assertHelmTemplateFails(
    ['publishedExecutionAdmission.maxActiveRunsPerPod=0'],
    /publishedExecutionAdmission\.maxActiveRunsPerPod must be an integer between 1 and 10000/,
  );
  await assertHelmTemplateFails(
    ['writableVolumeLimits.workspace=0Gi'],
    /writableVolumeLimits\.workspace must be a positive binary Kubernetes quantity such as 2Gi/,
  );
  await assertHelmTemplateFails(
    ['resources.execution.requests.memory=not-a-quantity'],
    /resources\.execution\.requests\.memory must be a positive Kubernetes quantity string when set/,
  );
  await assertHelmTemplateFails(
    ['resources.execution.requests.memory=1..Gi'],
    /resources\.execution\.requests\.memory must be a positive Kubernetes quantity string when set/,
  );
  await assertHelmTemplateFails(
    ['resources.execution.limits.ephemeral-storage=1'],
    /resources\.execution\.limits\.ephemeral-storage must be a positive Kubernetes quantity string when set/,
  );
  await assertHelmTemplateFails(
    ['resources.execution.requests.memory=0Mi'],
    /resources\.execution\.requests\.memory must be a positive Kubernetes quantity string when set/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE=enforce'],
    /RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE[\s\S]*configure publishedExecutionAdmission instead/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_MANAGED_MAINTENANCE_ENABLED=false'],
    /RIVET_MANAGED_MAINTENANCE_ENABLED[\s\S]*configure managedMaintenance instead/,
  );
  await assertHelmTemplateFails(
    ['managedMaintenance.leaseMs=1'],
    /managedMaintenance\.leaseMs must be an integer between 15000 and 600000/,
  );
  await assertHelmTemplateFails(
    ['evaluationRetention.mode=remove'],
    /evaluationRetention\.mode must be audit, enforce, or disabled/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_MANAGED_EVALUATION_RETENTION_MODE=enforce'],
    /RIVET_MANAGED_EVALUATION_RETENTION_MODE[\s\S]*configure evaluationRetention\.mode instead/,
  );
  await assertHelmTemplateFails(
    ['staleUploadRetention.mode=remove'],
    /staleUploadRetention\.mode must be audit, enforce, or disabled/,
  );
  await assertHelmTemplateFails(
    ['staleUploadRetention.minimumCandidateAgeHours=12'],
    /staleUploadRetention\.minimumCandidateAgeHours must be an integer between 24 and 720/,
  );
  await assertHelmTemplateFails(
    ['staleUploadRetention.requiredCompletedScans=1'],
    /staleUploadRetention\.requiredCompletedScans must be an integer between 2 and 10/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE=enforce'],
    /RIVET_MANAGED_STALE_UPLOAD_RETENTION_MODE[\s\S]*configure staleUploadRetention instead/,
  );
});

test('chart makes pull-only metrics and Prometheus Operator resources explicit opt-ins', async () => {
  const defaultChart = await renderLocalKubernetesChart();
  const metricsChart = await renderLocalKubernetesChartWithOverrides([
    'metrics.enabled=true',
    'metrics.serviceMonitor.enabled=true',
    'metrics.prometheusRule.enabled=true',
    'metrics.serviceMonitor.interval=1h30m',
    'metrics.serviceMonitor.additionalLabels.release=prometheus',
    'metrics.prometheusRule.failureModeAlerts.enabled=true',
    'metrics.prometheusRule.clusterStateAlerts.enabled=true',
  ]);
  const apiEntrypoint = readRepoFile('deploy/studio-server/images/api/entrypoint.sh');
  const dashboardChart = await renderLocalKubernetesChartWithOverrides([
    'metrics.enabled=true',
    'metrics.grafanaDashboards.enabled=true',
  ]);
  const validationTemplate = readRepoFile('deploy/studio-server/helm/templates/validate-values.yaml');

  assert.doesNotMatch(defaultChart, /kind: ServiceMonitor|kind: PrometheusRule/);
  assert.equal((metricsChart.match(/kind: ServiceMonitor/g) ?? []).length, 2);
  assert.doesNotMatch(defaultChart, /name: rivet-rivet-grafana-dashboards/);
  assert.match(
    dashboardChart,
    /kind: ConfigMap[\s\S]*?name: rivet-rivet-grafana-dashboards[\s\S]*?grafana_dashboard: "1"[\s\S]*?rivet-control-plane\.json:[\s\S]*?uid": "rivet-published-execution"/,
  );
  assert.doesNotMatch(dashboardChart, /DS_PROMETHEUS/);
  assert.match(dashboardChart, /"uid": "\$datasource"[\s\S]*?"type": "datasource"/);
  const evaluationMetricsChart = await renderLocalKubernetesChartWithOverrides([
    'hostedEvaluations.enabled=true',
    'metrics.enabled=true',
    'metrics.serviceMonitor.enabled=true',
  ]);
  assert.equal((evaluationMetricsChart.match(/kind: ServiceMonitor/g) ?? []).length, 3);
  assert.match(
    evaluationMetricsChart,
    /name: rivet-rivet-evaluation-metrics[\s\S]*?app\.kubernetes\.io\/component: evaluation[\s\S]*?path: \/metrics/,
  );
  assert.match(metricsChart, /interval: "1h30m"/);
  assert.match(
    metricsChart,
    /name: rivet-rivet-api-metrics[\s\S]*?app\.kubernetes\.io\/component: api[\s\S]*?path: \/metrics/,
  );
  assert.match(
    metricsChart,
    /name: rivet-rivet-execution-metrics[\s\S]*?app\.kubernetes\.io\/component: execution[\s\S]*?path: \/metrics/,
  );
  assert.match(metricsChart, /kind: PrometheusRule[\s\S]*?alert: RivetExecutionReadinessUnavailable/);
  assert.match(metricsChart, /alert: RivetPublishedExecutionAdmissionSaturated/);
  assert.match(metricsChart, /alert: RivetPostgresPoolWaiters/);
  assert.match(metricsChart, /alert: RivetRuntimeLibraryJobFailures/);
  assert.match(metricsChart, /alert: RivetManagedMaintenanceStale/);
  assert.match(metricsChart, /alert: RivetManagedDeletionOutboxBlocked/);
  assert.match(metricsChart, /alert: RivetHostedEvaluationQueueSaturated/);
  assert.match(metricsChart, /alert: RivetAppSettingsReplicaSynchronizationStale/);
  assert.match(metricsChart, /alert: RivetPublishedExecutionContainerRestarts/);
  assert.match(metricsChart, /alert: RivetPublishedExecutionContainerOOMKilled/);
  assert.match(metricsChart, /alert: RivetPublishedExecutionPodEvicted/);
  assert.match(
    metricsChart,
    /sum by \(namespace, profile\) \(time\(\) - rivet_managed_settings_last_success_timestamp_seconds > 900\) > 0/,
  );
  assert.doesNotMatch(defaultChart, /alert: RivetPostgresPoolWaiters/);
  assert.equal(
    (metricsChart.match(/name: RIVET_DEPLOYMENT_METRICS_ENABLED\s*\n\s*value: "true"/g) ?? []).length,
    2,
    'both direct API services must opt in before they expose /metrics',
  );
  assert.match(
    apiEntrypoint,
    /deployment_metrics_enabled="\$\{RIVET_DEPLOYMENT_METRICS_ENABLED:-\}"[\s\S]*?load_optional_dotenv \/vault\/dotenv[\s\S]*?RIVET_METRICS_ENABLED "\$deployment_metrics_enabled"/,
  );
  await assertHelmTemplateFails(
    ['metrics.prometheusRule.failureModeAlerts.enabled=true'],
    /requires metrics\.prometheusRule\.enabled=true/,
  );
  await assertHelmTemplateFails(
    ['metrics.prometheusRule.clusterStateAlerts.enabled=true'],
    /requires metrics\.prometheusRule\.enabled=true/,
  );
  await assertHelmTemplateFails(
    ['metrics.prometheusRule.clusterStateAlerts.restartIncrease=0'],
    /restartIncrease must be greater than zero/,
  );
  await assertHelmTemplateFails(
    ['metrics.prometheusRule.failureModeAlerts.evaluationQueueUtilization=1.1'],
    /must be a number greater than zero and at most one/,
  );
  assert.match(validationTemplate, /RIVET_METRICS_ENABLED[\s\S]*?configure metrics instead/);

  await assertHelmTemplateFails(
    ['metrics.serviceMonitor.enabled=true'],
    /metrics\.serviceMonitor\.enabled requires metrics\.enabled=true/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_METRICS_ENABLED=true'],
    /RIVET_METRICS_ENABLED[\s\S]*configure metrics instead/,
  );
  await assertHelmTemplateFails(
    ['metrics.serviceMonitor.interval=0s'],
    /metrics\.serviceMonitor\.interval must be a positive Prometheus duration/,
  );
  await assertHelmTemplateFails(
    ['metrics.serviceMonitor.additionalLabels=invalid'],
    /metrics\.serviceMonitor\.additionalLabels must be a map/,
  );
  await assertHelmTemplateFails(
    ['metrics.grafanaDashboards.enabled=true'],
    /metrics\.grafanaDashboards\.enabled requires metrics\.enabled=true/,
  );
});
test('chart exposes aggregate proxy metrics only through opt-in internal resources', async () => {
  const defaultChart = await renderLocalKubernetesChart();
  const proxyMetricsChart = await renderLocalKubernetesChartWithOverrides([
    'metrics.enabled=true',
    'metrics.proxyExporter.enabled=true',
    'metrics.serviceMonitor.enabled=true',
  ]);
  const proxyTemplate = readRepoFile('deploy/studio-server/images/proxy/default.conf.template');

  assert.doesNotMatch(defaultChart, /name: metrics-exporter/);
  assert.doesNotMatch(defaultChart, /name: rivet-rivet-proxy-metrics/);
  assert.match(
    proxyTemplate,
    /server \{\s*listen 127\.0\.0\.1:18080;[\s\S]*?location = \/stub_status \{\s*stub_status;/,
  );
  assert.match(proxyTemplate, /server \{\s*listen 8080;[\s\S]*?include \$\{RIVET_PUBLIC_ROUTES_INCLUDE_FILE\};/);
  assert.doesNotMatch(proxyTemplate, /listen 8080;[\s\S]*?location = \/metrics/);

  assert.match(
    proxyMetricsChart,
    /name: metrics-exporter[\s\S]*?image: nginx\/nginx-prometheus-exporter@sha256:9f6d963bb2b19d706d401cc3e2c3ea8de2f1c471b96a2156ca45e76f650b1625[\s\S]*?--nginx\.scrape-uri=http:\/\/127\.0\.0\.1:18080\/stub_status/,
  );
  assert.match(
    proxyMetricsChart,
    /name: rivet-rivet-proxy[\s\S]*?name: metrics\s*\n\s*port: 9113\s*\n\s*targetPort: metrics/,
  );
  assert.match(
    proxyMetricsChart,
    /name: rivet-rivet-proxy-metrics[\s\S]*?app\.kubernetes\.io\/component: proxy[\s\S]*?port: metrics[\s\S]*?path: \/metrics/,
  );

  await assertHelmTemplateFails(
    ['metrics.proxyExporter.enabled=true'],
    /metrics\.proxyExporter\.enabled requires metrics\.enabled=true/,
  );
  await assertHelmTemplateFails(
    ['metrics.enabled=true', 'metrics.proxyExporter.enabled=true', 'metrics.proxyExporter.port=80'],
    /metrics\.proxyExporter\.port must be an unprivileged TCP port between 1024 and 65535/,
  );
  await assertHelmTemplateFails(
    ['metrics.enabled=true', 'metrics.proxyExporter.enabled=true', 'metrics.proxyExporter.resources.requests.memory='],
    /metrics\.proxyExporter\.resources\.requests\.memory must be a positive Kubernetes quantity string/,
  );
  await assertHelmTemplateFails(
    ['metrics.enabled=true', 'metrics.proxyExporter.enabled=true', 'metrics.proxyExporter.port=9113.5'],
    /metrics\.proxyExporter\.port must be a positive whole-number TCP port/,
    '--set-json',
  );
  await assertHelmTemplateFails(
    ['webAppActionRetention.retentionHours=1.5'],
    /webAppActionRetention\.retentionHours must be a positive whole number of hours/,
    '--set-json',
  );
});

test('chart rejects fractional native values for integral runtime and Kubernetes controls', async () => {
  for (const [override, expectedMessage] of [
    [
      'hostedEvaluations.workerConcurrency=1.5',
      /hostedEvaluations\.workerConcurrency must be a non-negative whole number/,
    ],
    [
      'publishedExecutionAdmission.maxActiveRunsPerPod=4.5',
      /publishedExecutionAdmission\.maxActiveRunsPerPod must be a non-negative whole number/,
    ],
    ['postgres.poolMaxPerApiPod=10.5', /postgres\.poolMaxPerApiPod must be a non-negative whole number/],
    ['postgres.port=5432.5', /postgres\.port must be a non-negative whole number/],
    ['service.api.targetPort=8080.5', /service\.api\.targetPort must be a non-negative whole number/],
    [
      'autoscaling.execution.maxReplicas=10.5',
      /autoscaling\.execution\.maxReplicas must be a non-negative whole number/,
    ],
    ['managedMaintenance.batchSize=100.5', /managedMaintenance\.batchSize must be a non-negative whole number/],
    [
      'workflowSchema.compatibility.maximumVersion=10.5',
      /workflowSchema\.compatibility\.maximumVersion must be a non-negative whole number/,
    ],
    [
      'lifecycle.probes.readiness.failureThreshold=2.5',
      /lifecycle\.probes\.readiness\.failureThreshold must be a non-negative whole number/,
    ],
    [
      'availability.topologySpread.maxSkew=1.5',
      /availability\.topologySpread\.maxSkew must be a non-negative whole number/,
    ],
  ] as const) {
    await assertHelmTemplateFails([override], expectedMessage, '--set-json');
  }
});

test('chart serializes managed workflow migrations before verify-only API workloads start', async () => {
  const renderedChart = await renderLocalKubernetesChart();
  const renderedChartWithRollbackWindow = await renderLocalKubernetesChartWithOverrides([
    'workflowSchema.compatibility.minimumVersion=1',
  ]);
  const migrationJobDocument = renderedChart
    .split('# Source: rivet/templates/workflow-schema-migration-job.yaml')[1]
    ?.split('\n---\n')[0];
  const chartHelpers = readRepoFile('deploy/studio-server/helm/templates/_helpers.tpl');
  const migrationJobTemplate = readRepoFile('deploy/studio-server/helm/templates/workflow-schema-migration-job.yaml');

  assert.ok(migrationJobDocument, 'rendered chart should contain the workflow schema migration Job');

  assert.match(renderedChart, /kind: Job[\s\S]*?app\.kubernetes\.io\/component: workflow-schema-migration/);
  assert.match(renderedChart, /helm\.sh\/hook: pre-install,pre-upgrade/);
  assert.match(renderedChart, /helm\.sh\/hook-delete-policy: before-hook-creation,hook-succeeded/);
  assert.match(migrationJobTemplate, /include "rivet\.vaultAnnotations"/);
  assert.match(chartHelpers, /vault\.hashicorp\.com\/agent-pre-populate-only: "true"/);
  assert.match(
    renderedChart,
    /bootstrap-deployment-storage-settings\.mjs; RIVET_APP_SETTINGS_BACKEND=file RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION="10" RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION="10" node \/app\/packages\/studio-server-api\/dist\/studio-server-api\/src\/scripts\/migrate-managed-workflow-schema\.js migrate; node \/app\/packages\/studio-server-api\/dist\/studio-server-api\/src\/scripts\/import-managed-app-settings\.js/,
  );
  assert.match(
    renderedChartWithRollbackWindow,
    /RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION="10" RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION="10" node \/app\/packages\/studio-server-api\/dist\/studio-server-api\/src\/scripts\/migrate-managed-workflow-schema\.js migrate/,
    'the migration Job must use the exact candidate version even when serving pods support a lower rollback version',
  );
  assert.match(migrationJobDocument, /name: RIVET_APP_DATA_ROOT\s*\n\s*value: "\/var\/tmp\/rivet-migration-app-data"/);
  const migrationEnvironmentNames = [...migrationJobDocument.matchAll(/^\s+- name: (RIVET_[A-Z0-9_]+)\s*$/gm)].map(
    (match) => match[1],
  );
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
    /app\.kubernetes\.io\/component: workflow-schema-migration[\s\S]*?name: migrate[\s\S]*?resources:\s*\n\s*requests:\s*\n\s*cpu: 250m\s*\n\s*memory: 512Mi/,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE\s*\n\s*value: verify/g) ?? []).length,
    2,
    'control and execution API pods must verify the schema instead of mutating it',
  );
  const kubernetesVerifier = readRepoFile('deploy/studio-server/scripts/verify-kubernetes.mjs');
  assert.match(kubernetesVerifier, /readManagedWorkflowSchemaReleaseContract\(rootDir\)\.version/);
  assert.doesNotMatch(kubernetesVerifier, /managedWorkflowSchemaVersion=3/);
  assert.match(
    readRepoFile('deploy/studio-server/images/api/entrypoint.sh'),
    /deployment_managed_workflow_schema_mode="\$\{RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE:-\}"[\s\S]*load_optional_dotenv \/vault\/dotenv[\s\S]*RIVET_MANAGED_WORKFLOW_SCHEMA_MODE="\$deployment_managed_workflow_schema_mode"/,
  );
});

test('Vault dotenv injection runs before chart init containers and reserves bounded agent resources', async () => {
  const chartHelpers = readRepoFile('deploy/studio-server/helm/templates/_helpers.tpl');
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    'vault.enabled=true',
    'vault.role=contract-test',
    'vault.secretPath=secret/data/rivet/contract-test',
    'vault.dotenvTemplate=RIVET_KEY=secret/data/rivet/contract-test',
  ]);

  assert.match(
    chartHelpers,
    /range \$key, \$value := \.Values\.vault\.annotations[\s\S]*?vault\.hashicorp\.com\/agent-init-first: "true"/,
  );
  assert.match(
    chartHelpers,
    /agent-init-first: "true"[\s\S]*?agent-requests-cpu:[\s\S]*?agent-requests-mem:[\s\S]*?agent-requests-ephemeral:[\s\S]*?agent-limits-cpu:[\s\S]*?agent-limits-mem:[\s\S]*?agent-limits-ephemeral:/,
  );
  for (const annotation of [
    'agent-init-first: "true"',
    'agent-requests-cpu: "50m"',
    'agent-requests-mem: "64Mi"',
    'agent-requests-ephemeral: "64Mi"',
    'agent-limits-cpu: "250m"',
    'agent-limits-mem: "128Mi"',
    'agent-limits-ephemeral: "256Mi"',
  ]) {
    assert.equal(
      (renderedChart.match(new RegExp(`vault\\.hashicorp\\.com/${annotation}`, 'g')) ?? []).length,
      4,
      `every Vault-injected workload should emit ${annotation}`,
    );
  }

  await assertHelmTemplateFails(
    [
      'vault.enabled=true',
      'vault.role=contract-test',
      'vault.secretPath=secret/data/rivet/contract-test',
      'vault.dotenvTemplate=RIVET_KEY=secret/data/rivet/contract-test',
      'vault.agentResources.requests.cpu=not-a-quantity',
    ],
    /vault\.agentResources\.requests\.cpu must be a positive Kubernetes quantity string/,
  );
  await assertHelmTemplateFails(
    [
      'vault.enabled=true',
      'vault.role=contract-test',
      'vault.secretPath=secret/data/rivet/contract-test',
      'vault.dotenvTemplate=RIVET_KEY=secret/data/rivet/contract-test',
      'vault.agentResources.limits.ephemeral-storage=0Mi',
    ],
    /vault\.agentResources\.limits\.ephemeral-storage must be a positive Kubernetes quantity string/,
  );
});

test('chart can delegate migration execution but never lets API replicas become schema writers', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides(['workflowSchema.migrationJob.enabled=false']);

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
  const validateValuesTemplate = readRepoFile('deploy/studio-server/helm/templates/validate-values.yaml');
  const backendStatefulSet = readRepoFile('deploy/studio-server/helm/templates/backend-statefulset.yaml');

  assert.match(validateValuesTemplate, /workflowStorage\.backend=managed and runtimeLibraries\.backend=managed/);
  assert.match(
    validateValuesTemplate,
    /replicaCount\.backend=1 is required because \/ws\/latest-debugger and co-located editor executor session routing remain process-local control-plane features/,
  );
  assert.match(
    validateValuesTemplate,
    /autoscaling\.backend\.enabled=false is required because \/ws\/latest-debugger and co-located editor executor session routing remain process-local control-plane features/,
  );
  assert.match(
    validateValuesTemplate,
    /appSettings\.backend=postgres so settings remain consistent across replicas without a shared app-data volume/,
  );
  assert.match(backendStatefulSet, /replicas: \{\{ \.Values\.replicaCount\.backend \}\}/);
  assert.match(backendStatefulSet, /podManagementPolicy: OrderedReady/);
  assert.match(backendStatefulSet, /updateStrategy:\s*\n\s*type: RollingUpdate/);
  assert.match(backendStatefulSet, /StatefulSets do not expose Deployment's Recreate strategy/);
});

test('chart budgets PostgreSQL connections against the maximum execution replica count', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    'autoscaling.execution.enabled=true',
    'autoscaling.execution.minReplicas=2',
    'autoscaling.execution.maxReplicas=4',
  ]);

  assert.match(renderedChart, /name: RIVET_DEPLOYMENT_DATABASE_POOL_MAX\s*\n\s*value: "10"/);
  assert.match(renderedChart, /resources:\s*\n\s*requests:\s*\n\s*cpu: 500m\s*\n\s*memory: 1Gi/);

  await assertHelmTemplateFails(
    ['postgres.maxConnections=100', 'autoscaling.execution.enabled=true', 'autoscaling.execution.maxReplicas=10'],
    /requires 173 connections \(30 reserved \+ 11 API pods \* \(10 pooled \+ 3 LISTEN\)\), but postgres\.maxConnections is 100/,
  );
  await assertHelmTemplateFails(
    ['env.RIVET_DEPLOYMENT_DATABASE_POOL_MAX=99'],
    /configure postgres\.poolMaxPerApiPod instead/,
  );
  await assertHelmTemplateFails(
    ['autoscaling.execution.enabled=true', 'autoscaling.execution.maxReplicas=4', 'resources.execution.requests.cpu='],
    /resources\.execution\.requests\.cpu is required when execution autoscaling is enabled/,
  );
});

test('chart renders profile-aware probes, graceful lifecycle, and replicated-tier availability policies', async () => {
  const renderedChart = await renderLocalKubernetesChart();

  assert.equal((renderedChart.match(/path: \/readyz/g) ?? []).length, 2);
  assert.equal((renderedChart.match(/path: \/livez/g) ?? []).length, 4);
  assert.equal((renderedChart.match(/startupProbe:/g) ?? []).length, 5);
  assert.equal((renderedChart.match(/livenessProbe:/g) ?? []).length, 5);
  assert.equal((renderedChart.match(/readinessProbe:/g) ?? []).length, 5);
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS\s*\n\s*value: "120"/g) ?? []).length,
    2,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_HEALTH_REFRESH_SECONDS\s*\n\s*value: "5"/g) ?? []).length,
    2,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_HEALTH_CHECK_TIMEOUT_SECONDS\s*\n\s*value: "3"/g) ?? []).length,
    2,
  );
  assert.equal(
    (renderedChart.match(/name: RIVET_DEPLOYMENT_HEALTH_STALE_AFTER_SECONDS\s*\n\s*value: "20"/g) ?? []).length,
    2,
  );
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
  const prodOverlay = readRepoFile('deploy/studio-server/helm/overlays/prod.yaml');

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
  assert.match(prodOverlay, /maxConnections:\s*200/);
  assert.match(prodOverlay, /reservedConnections:\s*30/);
  assert.match(prodOverlay, /poolMaxPerApiPod:\s*10/);
  assert.match(prodOverlay, /writableVolumeLimits:\s*\n\s*workspace:\s*2Gi[\s\S]*?runtimeLibraries:\s*8Gi/);
  assert.match(
    prodOverlay,
    /resourceLimitAcknowledgements:[\s\S]*?execution:[\s\S]*?memory:\s*"[^"]{24,}"[\s\S]*?ephemeralStorage:\s*"[^"]{24,}"/,
  );
  assert.match(prodOverlay, /release:\s*\n\s*production:[\s\S]*?enabled:\s*true/);
});

test('production rendering requires a fully identified digest-pinned release', async () => {
  const helmBin = await resolveHelmBin();
  const baseArgs = [
    'template',
    'rivet-prod',
    'deploy/studio-server/helm',
    '--namespace',
    'rivet-prod',
    '--values',
    'deploy/studio-server/helm/overlays/prod.yaml',
    '--set',
    'images.proxy.repository=ghcr.io/example/proxy',
    '--set',
    'images.web.repository=ghcr.io/example/web',
    '--set',
    'images.api.repository=ghcr.io/example/api',
    '--set',
    'images.executor.repository=ghcr.io/example/executor',
  ];
  const identifiedReleaseArgs = [
    '--set',
    `images.proxy.digest=sha256:${'a'.repeat(64)}`,
    '--set',
    `images.web.digest=sha256:${'b'.repeat(64)}`,
    '--set',
    `images.api.digest=sha256:${'c'.repeat(64)}`,
    '--set',
    `images.executor.digest=sha256:${'d'.repeat(64)}`,
    '--set',
    `release.production.manifestDigest=sha256:${'f'.repeat(64)}`,
    '--set',
    `release.production.sourceSha=${'e'.repeat(40)}`,
    '--set',
    'release.production.verification.workflow=Build-Images',
    '--set',
    'release.production.verification.runId=12345',
    '--set',
    'release.production.verification.runAttempt=1',
    '--set',
    'release.production.chart.name=rivet',
    '--set',
    'release.production.chart.version=0.1.0',
    '--set',
    `release.production.chart.contentDigest=sha256:${'f'.repeat(64)}`,
    '--set',
    'release.production.database.managedWorkflowSchemaVersion=10',
  ];
  const renderProduction = (overrides: string[] = []) =>
    execFileSync(helmBin, [...baseArgs, ...identifiedReleaseArgs, ...overrides], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });

  assert.throws(
    () => execFileSync(helmBin, baseArgs, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }),
    /release\.production\.manifestDigest must be the canonical sha256 digest/,
  );

  const rendered = renderProduction();
  assert.match(rendered, /kind: ConfigMap[\s\S]*?name: rivet-prod-rivet-release-identity/);
  assert.match(rendered, new RegExp(`release-manifest-digest: "sha256:${'f'.repeat(64)}"`));
  assert.match(rendered, new RegExp(`chart-content-digest: "sha256:${'f'.repeat(64)}"`));
  assert.match(rendered, new RegExp(`image: ghcr.io/example/api@sha256:${'c'.repeat(64)}`));

  assert.throws(
    () => renderProduction(['--set-string', 'resourceLimitAcknowledgements.execution.memory=']),
    /production requires resources\.execution memory request and limit or a 24-character resourceLimitAcknowledgements\.execution\.memory rationale/,
  );
  assert.throws(
    () =>
      renderProduction([
        '--set',
        'resources.execution.requests.memory=1Gi',
        '--set',
        'resources.execution.limits.memory=2Gi',
      ]),
    /resourceLimitAcknowledgements\.execution\.memory must be empty when resources\.execution has memory request and limit/,
  );
});

test('local Kubernetes overlay keeps the backend singleton while scaling endpoint-serving tiers and enabling latest debugger support', () => {
  const localOverlay = readRepoFile('deploy/studio-server/helm/overlays/local-kubernetes.yaml');

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

test('self-contained Minikube dependencies stay isolated and match the local launcher contract', () => {
  const dependencies = readRepoFile('deploy/studio-server/kubernetes-test/local-dependencies.yaml');
  const environment = readRepoFile('deploy/studio-server/.env.kubernetes-local.example');

  assert.match(dependencies, /kind: Namespace\s*\nmetadata:\s*\n  name: rivet-local/);
  assert.match(dependencies, /name: rivet-local-postgres/);
  assert.match(dependencies, /image: postgres:16\.8-alpine/);
  assert.match(dependencies, /name: rivet-local-minio/);
  assert.match(dependencies, /image: minio\/minio:RELEASE\.2025-04-22T22-12-26Z/);
  assert.match(dependencies, /mc mb --ignore-existing local\/rivet-workflows/);
  assert.match(dependencies, /storage: 2Gi/);
  assert.doesNotMatch(dependencies, /example\.invalid|ghcr\.io|digitaloceanspaces\.com/);

  assert.match(environment, /RIVET_K8S_CONTEXT=rivet-local/);
  assert.match(environment, /RIVET_K8S_NAMESPACE=rivet-local/);
  assert.match(environment, /rivet-local-postgres\.rivet-local\.svc\.cluster\.local/);
  assert.match(environment, /rivet-local-minio\.rivet-local\.svc\.cluster\.local/);
  assert.match(environment, /RIVET_K8S_DATABASE_SSL_MODE=disable/);
});

test('local Kubernetes launcher builds every image from the monorepo root', () => {
  const kubernetesLauncher = readRepoFile('deploy/studio-server/scripts/dev-kubernetes.mjs');

  for (const service of ['api', 'executor', 'web', 'proxy']) {
    assert.match(kubernetesLauncher, new RegExp(`deploy/studio-server/images/${service}/Dockerfile`));
  }
  assert.match(kubernetesLauncher, /\['build', '-f', spec\.dockerfile, '-t', buildImageRef\(spec\.image\), '\.'\]/);
  assert.doesNotMatch(
    kubernetesLauncher,
    /prepareRivetDockerContext|--build-context|rivet_source|rivet_dependency_metadata/,
  );
});

test('executor app-data path remains intentionally separate from API app-data mounts', () => {
  const podPartials = readRepoFile('deploy/studio-server/helm/templates/_pod.tpl');

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

test('chart uses an immutable image digest when a release gate supplies one', async () => {
  const proxyDigest = `sha256:${'a'.repeat(64)}`;
  const renderedChart = await renderLocalKubernetesChartWithOverrides([
    `images.proxy.digest=${proxyDigest}`,
    `images.web.digest=sha256:${'b'.repeat(64)}`,
    `images.api.digest=sha256:${'c'.repeat(64)}`,
    `images.executor.digest=sha256:${'d'.repeat(64)}`,
  ]);

  assert.match(renderedChart, new RegExp(`image: rivet-local/proxy@${proxyDigest}`));
  assert.doesNotMatch(renderedChart, /image: rivet-local\/proxy:dev/);
});

test('chart forwards arbitrary runtime credentials without a provider-specific template list', async () => {
  const renderedChart = await renderLocalKubernetesChartWithOverrides(['env.BILLING_OPENAI_KEY=chart-test-secret']);

  assert.equal(
    (renderedChart.match(/name: BILLING_OPENAI_KEY\s*\n\s*value: "chart-test-secret"/g) ?? []).length,
    3,
    'only the control API, execution API, and editor executor should receive arbitrary runtime credentials',
  );
  assert.match(
    readRepoFile('deploy/studio-server/helm/templates/proxy-deployment.yaml'),
    /include "rivet\.env\.proxyValues"/,
  );
  assert.match(
    readRepoFile('deploy/studio-server/helm/templates/proxy-deployment.yaml'),
    /include "rivet\.vaultProxyAnnotations"/,
  );
  assert.match(
    readRepoFile('deploy/studio-server/helm/templates/_helpers.tpl'),
    /RIVET_KEY=\{\{ "\{\{ \.Data\.data\.RIVET_KEY \| toJSON \}\}" \}\}/,
  );
  assert.doesNotMatch(
    readRepoFile('deploy/studio-server/helm/templates/_env.tpl'),
    /OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY/,
  );
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
  await assertHelmTemplateFails(
    ['env.RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION=3'],
    /workflowSchema\.compatibility through the immutable release manifest/,
  );
});
