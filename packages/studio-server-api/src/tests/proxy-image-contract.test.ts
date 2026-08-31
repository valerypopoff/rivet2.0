import assert from 'node:assert/strict';
import test from 'node:test';

import { extractBracedBlock, readRepoFile, readRepoJson } from './helpers/repo-contract-helpers.js';

const proxyTemplatePaths = [
  'deploy/studio-server/images/proxy/default.conf.template',
  'deploy/studio-server/compose/nginx/default.conf.template',
  'deploy/studio-server/compose/nginx/default.dev.conf.template',
] as const;

function readProxyTemplates(): string[] {
  return proxyTemplatePaths.map((templatePath) => readRepoFile(templatePath));
}

function proxyLocation(template: string, locationPattern: RegExp): string {
  return extractBracedBlock(template, locationPattern);
}

function proxyPublicLocation(template: string, locationPattern: RegExp): string {
  const publicServer = extractBracedBlock(template, /server\s*\{\s*listen (?:80|8080);/);
  return extractBracedBlock(publicServer, locationPattern);
}

function composeServiceBlock(compose: string, service: string): string {
  const marker = `\n  ${service}:`;
  const markerIndex = compose.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected ${service} service to exist.`);
  const start = markerIndex + 1;
  const afterMarker = start + marker.length - 1;
  const nextService = /\r?\n  [a-z][a-z0-9-]*:/i.exec(compose.slice(afterMarker));
  return compose.slice(start, nextService ? afterMarker + nextService.index : compose.length);
}

test('proxy templates route public workflow traffic to the right API plane', () => {
  const imageProxyTemplate = readRepoFile('deploy/studio-server/images/proxy/default.conf.template');
  const proxyBootstrap = readRepoFile('deploy/studio-server/images/proxy/normalize-workflow-paths.sh');

  assert.match(
    proxyLocation(imageProxyTemplate, /location = \/__rivet_auth\s*\{/),
    /proxy_pass \$api_ui_auth_upstream;/,
  );
  assert.match(proxyLocation(imageProxyTemplate, /location \/api\/\s*\{/), /proxy_pass \$api_upstream;/);
  assert.match(imageProxyTemplate, /include \$\{RIVET_PUBLIC_ROUTES_INCLUDE_FILE\};/);
  assert.match(proxyBootstrap, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /location \$\{RIVET_WEB_APPS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /location \$\{RIVET_LATEST_WEB_APPS_BASE_PATH\}\/ \{/);
  assert.match(
    proxyBootstrap,
    /proxy_pass \\\$execution_upstream;[\s\S]*proxy_pass \\\$execution_upstream;[\s\S]*proxy_pass \\\$api_upstream;[\s\S]*proxy_pass \\\$api_upstream;/,
  );
  assert.match(proxyBootstrap, /location ~ \^\$\{RIVET_WEB_APPS_BASE_PATH\}\/\[\^\/\]\+\/actions\/ws\$ \{/);
  assert.match(proxyBootstrap, /location ~ \^\$\{RIVET_LATEST_WEB_APPS_BASE_PATH\}\/\[\^\/\]\+\/actions\/ws\$ \{/);
  assert.match(
    proxyBootstrap,
    /actions\/ws\$ \{[\s\S]*?proxy_pass \\\$execution_upstream;[\s\S]*?proxy_set_header Upgrade \\\$http_upgrade;[\s\S]*?proxy_read_timeout 86400s;[\s\S]*?proxy_buffering off;/,
  );
  assert.match(
    proxyBootstrap,
    /actions\/ws\$ \{[\s\S]*?proxy_pass \\\$api_upstream;[\s\S]*?proxy_set_header Upgrade \\\$http_upgrade;[\s\S]*?proxy_read_timeout 86400s;[\s\S]*?proxy_buffering off;/,
  );

  const latestDebuggerLocation = proxyLocation(imageProxyTemplate, /location \/ws\/latest-debugger\s*\{/);
  assert.match(
    imageProxyTemplate,
    /set \$api_latest_debugger_upstream http:\/\/\$\{RIVET_API_UPSTREAM_HOST\}:\$\{RIVET_API_UPSTREAM_PORT\}\/ws\/latest-debugger;/,
  );
  assert.match(latestDebuggerLocation, /proxy_pass \$api_latest_debugger_upstream;/);
  assert.match(latestDebuggerLocation, /proxy_set_header X-Rivet-Proxy-Auth \$\{RIVET_PROXY_AUTH_TOKEN\};/);
  assert.match(latestDebuggerLocation, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(latestDebuggerLocation, /proxy_set_header Connection \$connection_upgrade;/);

  assert.ok(!imageProxyTemplate.includes('location /internal/workflows'));
  assert.match(proxyBootstrap, /resolve_proxy_resolver\(\)/);
  assert.match(proxyBootstrap, /fetch_proxy_settings\(\)/);
  assert.match(proxyBootstrap, /X-Rivet-Proxy-Auth: \$\{RIVET_PROXY_AUTH_TOKEN\}/);
  assert.match(proxyBootstrap, /RIVET_PROXY_SETTINGS_URL/);
  assert.match(proxyBootstrap, /proxy settings refresh failed; keeping the last valid nginx configuration/);
  assert.doesNotMatch(
    proxyBootstrap,
    /export RIVET_PROXY_SETTINGS_FILE="\$\{RIVET_PROXY_SETTINGS_FILE:-\/tmp\/nginx\/rivet-proxy-settings\.json\}"/,
  );
  assert.match(
    proxyBootstrap,
    /public_route_settings_file="\$\{RIVET_PROXY_SETTINGS_FILE:-\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/public-routes\.json\}"/,
  );
  assert.match(
    proxyBootstrap,
    /trusted_host_settings_file="\$\{RIVET_PROXY_SETTINGS_FILE:-\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/trusted-hosts\.json\}"/,
  );
  assert.match(
    proxyBootstrap,
    /legacy_web_app_route_settings_file="\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/web-app-routes\.json"/,
  );
  assert.match(proxyBootstrap, /normalize_public_route_setting\(\) \{/);
  assert.match(proxyBootstrap, /read_json_string_property "\$settings_file" "publishedWorkflowsBasePath"/);
  assert.match(proxyBootstrap, /read_json_string_property "\$settings_file" "latestWorkflowsBasePath"/);
  assert.match(proxyBootstrap, /read_json_string_property "\$settings_file" "publishedAppsBasePath"/);
  assert.match(proxyBootstrap, /read_json_string_property "\$settings_file" "latestAppsBasePath"/);
  assert.match(proxyBootstrap, /__rivet_auth\|api\|assets\|internal\|node_modules\|ui-auth\|ws/);
  assert.match(proxyBootstrap, /invalid public route settings file/);
  assert.match(proxyBootstrap, /RIVET_PUBLIC_ROUTES_SETTINGS_VALID=0/);
  assert.match(proxyBootstrap, /if \[ "\$\{RIVET_PUBLIC_ROUTES_SETTINGS_VALID:-1\}" != "1" \]; then[\s\S]*continue/);
  assert.match(proxyBootstrap, /RIVET_PUBLISHED_APPS_BASE_PATH:-\$\{RIVET_WEB_APPS_BASE_PATH:-\}/);
  assert.match(proxyBootstrap, /RIVET_LATEST_APPS_BASE_PATH:-\$\{RIVET_LATEST_WEB_APPS_BASE_PATH:-\}/);
  assert.match(proxyBootstrap, /write_public_routes_include\(\)/);
  assert.match(proxyBootstrap, /mkdir -p "\$output_dir"/);
  assert.match(proxyBootstrap, /RIVET_PUBLIC_ROUTES_INCLUDE_FILE:-\/tmp\/nginx\/rivet-public-routes\.inc/);
  assert.match(proxyBootstrap, /RIVET_TRUSTED_HOSTS_INCLUDE_FILE:-\/tmp\/nginx\/rivet-trusted-hosts\.inc/);
  assert.doesNotMatch(
    proxyBootstrap,
    /RIVET_PUBLIC_ROUTES_INCLUDE_FILE:-\$NGINX_ENVSUBST_OUTPUT_DIR\/rivet-public-routes\.conf/,
  );
  assert.match(proxyBootstrap, /write_trusted_hosts_include\(\)/);
  assert.match(proxyBootstrap, /trustedHostsCsv/);
  assert.match(proxyBootstrap, /nginx -t/);
  assert.match(proxyBootstrap, /nginx -s reload/);
  assert.match(
    proxyBootstrap,
    /export RIVET_PROXY_RESOLVER="\$\(resolve_proxy_resolver "\$\{RIVET_PROXY_RESOLVER:-\}"\)"/,
  );
});

test('proxy templates replace client correlation IDs before forwarding requests', () => {
  for (const template of readProxyTemplates()) {
    assert.match(template, /proxy_set_header X-Rivet-Correlation-Id \$request_id;/);
  }
});

test('proxy templates keep the authenticated workflow-tree event stream unbuffered and long-lived', () => {
  for (const template of readProxyTemplates()) {
    const streamLocation = proxyLocation(template, /location = \/api\/workflows\/tree\/events\s*\{/);
    const apiLocationIndex = template.indexOf('location /api/ {');
    const streamLocationIndex = template.indexOf('location = /api/workflows/tree/events {');

    assert.notEqual(streamLocationIndex, -1);
    assert.ok(streamLocationIndex < apiLocationIndex, 'The exact SSE route must precede the generic API route.');
    assert.match(streamLocation, /auth_request \/__rivet_ui_auth_check;/);
    assert.match(streamLocation, /proxy_http_version 1\.1;/);
    assert.match(streamLocation, /proxy_set_header X-Rivet-Proxy-Auth \$\{RIVET_PROXY_AUTH_TOKEN\};/);
    assert.match(streamLocation, /proxy_buffering off;/);
    assert.match(streamLocation, /proxy_cache off;/);
    assert.match(streamLocation, /proxy_read_timeout 86400s;/);
    assert.match(streamLocation, /proxy_send_timeout 86400s;/);
  }
});

test('proxy UI gate prompt is API-rendered and receives the original route', () => {
  const proxyBootstrap = readRepoFile('deploy/studio-server/images/proxy/normalize-workflow-paths.sh');
  const proxyDockerfile = readRepoFile('deploy/studio-server/images/proxy/Dockerfile');
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');

  for (const template of readProxyTemplates()) {
    const rootLocation = proxyPublicLocation(template, /location \/\s*\{/);
    const apiLocation = proxyLocation(template, /location \/api\/\s*\{/);
    const authCheckLocation = proxyLocation(template, /location = \/__rivet_ui_auth_check\s*\{/);
    const promptLocation = proxyLocation(template, /location @web_with_ui_gate_prompt\s*\{/);
    assert.match(template, /set \$api_ui_auth_check_upstream .*\/ui-auth\/check;/);
    assert.match(template, /set \$api_ui_auth_prompt_upstream .*\/ui-auth\/prompt;/);
    assert.match(template, /ui-auth\/check/);
    assert.match(template, /ui-auth\/prompt/);
    assert.match(rootLocation, /auth_request \/__rivet_ui_auth_check;/);
    assert.match(apiLocation, /auth_request \/__rivet_ui_auth_check;/);
    assert.match(authCheckLocation, /proxy_pass \$api_ui_auth_check_upstream;/);
    assert.match(authCheckLocation, /proxy_pass_request_body off;/);
    assert.match(authCheckLocation, /proxy_set_header X-Rivet-Token-Free-Host \$rivet_ui_host_is_token_free;/);
    assert.match(promptLocation, /proxy_pass \$api_ui_auth_prompt_upstream;/);
    assert.match(promptLocation, /proxy_set_header X-Rivet-Ui-Return-To \$request_uri;/);
    assert.doesNotMatch(promptLocation, /try_files \/ui-gate-prompt\.html =500;/);
  }

  assert.doesNotMatch(proxyBootstrap, /stage_ui_gate_prompt\(\)/);
  assert.doesNotMatch(proxyBootstrap, /ui-gate-prompt\.html/);
  assert.doesNotMatch(proxyDockerfile, /ui-gate-prompt\.html/);
  assert.doesNotMatch(devCompose, /ui-gate-prompt\.html:/);
  assert.doesNotMatch(prodCompose, /image\/proxy\/ui-gate-prompt\.html:/);
});

test('proxy templates forward hosted web apps to the API-owned auth layer', () => {
  const proxyBootstrap = readRepoFile('deploy/studio-server/images/proxy/normalize-workflow-paths.sh');
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');
  const managedCompose = readRepoFile('deploy/studio-server/compose/docker-compose.managed-services.yml');
  assert.doesNotMatch(proxyBootstrap, /normalize_web_apps_auth_mode\(\)/);
  assert.match(
    proxyBootstrap,
    /RIVET_TRUST_INCOMING_FORWARDED_HEADERS="\$\(normalize_bool "\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-\}" "0"\)"/,
  );
  assert.doesNotMatch(proxyBootstrap, /RIVET_WEB_APPS_AUTH_MODE/);
  assert.match(
    prodCompose,
    /RIVET_TRUST_INCOMING_FORWARDED_HEADERS=\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-false\}/,
  );
  assert.match(
    devCompose,
    /RIVET_TRUST_INCOMING_FORWARDED_HEADERS=\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-false\}/,
  );
  assert.doesNotMatch(prodCompose, /RIVET_UI_TOKEN_FREE_HOSTS/);
  assert.doesNotMatch(devCompose, /RIVET_UI_TOKEN_FREE_HOSTS/);
  assert.match(prodCompose, /RIVET_CORS_ALLOWED_ORIGINS=\$\{RIVET_CORS_ALLOWED_ORIGINS:-\}/);
  assert.match(devCompose, /RIVET_CORS_ALLOWED_ORIGINS=\$\{RIVET_CORS_ALLOWED_ORIGINS:-\}/);
  for (const compose of [prodCompose, devCompose]) {
    assert.match(
      compose,
      /proxy:[\s\S]*?- type: volume\s+source: rivet_data\s+target: \/data\/rivet-app\s+read_only: true\s+volume:\s+nocopy: true/,
    );
  }
  assert.match(devCompose, /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_API_PORT:-3100\}:80"/);
  assert.match(
    managedCompose,
    /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_WORKFLOWS_LOCAL_DOCKER_POSTGRES_PORT:-54329\}:5432"/,
  );
  assert.match(
    managedCompose,
    /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_WORKFLOWS_LOCAL_DOCKER_OBJECT_STORAGE_PORT:-9000\}:9000"/,
  );
  assert.match(
    managedCompose,
    /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_WORKFLOWS_LOCAL_DOCKER_OBJECT_STORAGE_CONSOLE_PORT:-9001\}:9001"/,
  );
  const retiredAuthEnvPattern =
    /RIVET_WEB_APPS_AUTH_MODE|RIVET_SERVER_UI_OAUTH_|(^|\W)OAUTH_PROVIDER|(^|\W)OAUTH_CLIENT_SECRET|(^|\W)OAUTH_DEBUG_LOG_PROFILE/;
  assert.doesNotMatch(prodCompose, retiredAuthEnvPattern);
  assert.doesNotMatch(devCompose, retiredAuthEnvPattern);

  for (const template of readProxyTemplates()) {
    assert.match(
      template,
      /map "\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS\}:\$http_x_forwarded_host" \$rivet_forwarded_host/,
    );
    assert.match(template, /default \$http_host;/);
    assert.match(template, /\~\^1:\(\.\+\)\$ \$1;/);
    assert.match(template, /map \$rivet_forwarded_host \$rivet_forwarded_hostname/);
    assert.ok(template.includes('~^\\[(?<ipv6_host>[^\\]]+)\\](?::\\d+)?$ $ipv6_host;'));
    assert.ok(template.includes('~^(?<plain_host>[^:]+):\\d+$ $plain_host;'));
    assert.match(
      template,
      /map "\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS\}:\$http_x_forwarded_proto" \$rivet_forwarded_proto/,
    );
    assert.match(template, /default \$scheme;/);
    assert.match(template, /map \$rivet_forwarded_hostname \$rivet_ui_host_is_token_free/);
    assert.match(template, /include \$\{RIVET_TRUSTED_HOSTS_INCLUDE_FILE\};/);
    assert.doesNotMatch(template, /RIVET_UI_TOKEN_FREE_HOSTS_REGEX/);
    assert.doesNotMatch(template, /rivet_ui_cookie_secure_suffix|rivet_ui_gate_result|RIVET_UI_SESSION_TOKEN/);
    assert.doesNotMatch(template, /RIVET_WEB_APPS_AUTH_MODE|rivet_web_apps_gate_result|rivet_web_apps_use_ui_gate/);
    assert.doesNotMatch(template, /proxy_set_header X-Forwarded-Proto \$scheme;/);
    assert.match(template, /include \$\{RIVET_PUBLIC_ROUTES_INCLUDE_FILE\};/);
  }

  assert.match(proxyBootstrap, /proxy_set_header X-Rivet-Token-Free-Host \\\$rivet_ui_host_is_token_free;/);
  assert.match(proxyBootstrap, /proxy_set_header X-Forwarded-Host \\\$rivet_forwarded_host;/);
  assert.match(proxyBootstrap, /proxy_set_header X-Forwarded-Proto \\\$rivet_forwarded_proto;/);
});

test('dev Compose exposes the host machine to both Node execution paths', () => {
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');

  assert.equal((devCompose.match(/host\.docker\.internal:host-gateway/g) ?? []).length, 2);
  assert.equal(
    (devCompose.match(/RIVET_NODE_EXECUTOR_PROXY_BYPASS_HOSTS=\$\{RIVET_NODE_EXECUTOR_PROXY_BYPASS_HOSTS:-\}/g) ?? [])
      .length,
    2,
  );
});

test('compose fallback artifact mounts stay isolated under app data', () => {
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /\$\{RIVET_WORKFLOWS_HOST_PATH:-\.\.\/\.\.\/\.\.\/\.data\/workflows\}:\/workflows/);
    assert.match(
      compose,
      /\$\{RIVET_WORKFLOW_RECORDINGS_HOST_PATH:-\.\.\/\.\.\/\.\.\/\.data\/workflow-recordings\}:\/workflow-recordings/,
    );
    assert.match(
      compose,
      /\$\{RIVET_RUNTIME_LIBS_HOST_PATH:-\.\.\/\.\.\/\.\.\/\.data\/runtime-libraries\}:\/data\/runtime-libraries/,
    );
    assert.doesNotMatch(compose, /\$\{RIVET_WORKFLOWS_HOST_PATH:-\.\.\/\.\.\/\.\.\/workflows\}:\/workflows/);
    assert.doesNotMatch(
      compose,
      /\$\{RIVET_WORKFLOW_RECORDINGS_HOST_PATH:-\.\.\/\.\.\/\.\.\/workflow-recordings\}:\/workflow-recordings/,
    );
  }
});

test('proxy templates keep HTTP workflow routes bounded and websocket routes long-lived', () => {
  const proxyDockerfile = readRepoFile('deploy/studio-server/images/proxy/Dockerfile');
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');

  for (const template of readProxyTemplates()) {
    for (const locationPattern of [/location \/api\/\s*\{/]) {
      const location = proxyLocation(template, locationPattern);
      assert.match(location, /include \$\{RIVET_PROXY_TIMEOUT_INCLUDE_FILE\};/);
    }

    assert.match(proxyLocation(template, /location \/ws\/latest-debugger\s*\{/), /proxy_read_timeout 86400s;/);
    assert.match(proxyLocation(template, /location \/ws\/executor\/internal\s*\{/), /proxy_read_timeout 86400s;/);
  }

  const proxyBootstrap = readRepoFile('deploy/studio-server/images/proxy/normalize-workflow-paths.sh');
  assert.match(
    proxyBootstrap,
    /runtime_limit_settings_file="\$\{RIVET_PROXY_SETTINGS_FILE:-\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/runtime-limits\.json\}"/,
  );
  assert.match(proxyBootstrap, /read_json_scalar_property "\$runtime_limit_settings_file" "proxyReadTimeoutSeconds"/);
  assert.match(
    proxyBootstrap,
    /read_json_scalar_property "\$runtime_limit_settings_file" "webAppActionRequestLimitBytes"/,
  );
  assert.match(proxyBootstrap, /\*\[!0123456789\]\*/);
  assert.match(proxyBootstrap, /RIVET_PROXY_READ_TIMEOUT="\$\{proxy_read_timeout_seconds\}s"/);
  assert.match(proxyBootstrap, /RIVET_WEB_APP_ACTION_REQUEST_LIMIT_BYTES="\$web_app_action_request_limit_bytes"/);
  assert.match(proxyBootstrap, /read_runtime_limit_settings/);
  assert.match(proxyBootstrap, /RIVET_PROXY_TIMEOUT_INCLUDE_FILE:-\/tmp\/nginx\/rivet-proxy-timeout\.inc/);
  assert.match(proxyBootstrap, /write_proxy_timeout_include\(\)/);
  assert.match(proxyBootstrap, /write_proxy_timeout_include "\$RIVET_PROXY_TIMEOUT_INCLUDE_FILE"/);
  assert.match(proxyBootstrap, /proxy_read_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
  assert.match(proxyBootstrap, /proxy_send_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
  assert.match(proxyBootstrap, /include \$\{RIVET_PROXY_TIMEOUT_INCLUDE_FILE\};/);
  assert.match(proxyBootstrap, /client_max_body_size \$\{RIVET_WEB_APP_ACTION_REQUEST_LIMIT_BYTES\};/);
  assert.match(proxyBootstrap, /previous_proxy_timeout_include/);
  assert.match(proxyDockerfile, /ENV RIVET_PROXY_READ_TIMEOUT=180s/);
  assert.doesNotMatch(prodCompose, /RIVET_PROXY_READ_TIMEOUT/);
  assert.doesNotMatch(devCompose, /RIVET_PROXY_READ_TIMEOUT/);
});

test('executor image and compose contracts keep the websocket service independent from API PORT', () => {
  const executorEntrypoint = readRepoFile('deploy/studio-server/images/executor/entrypoint.sh');
  const executorDockerfile = readRepoFile('deploy/studio-server/images/executor/Dockerfile');
  const executorBundler = readRepoFile('packages/studio-server-executor/build/bundle-executor.cjs');
  const executorHost = readRepoFile('packages/studio-server-executor/src/executor.mts');
  const composeExecutorDockerfile = readRepoFile('deploy/studio-server/compose/docker/Dockerfile.executor');
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');

  assert.match(executorEntrypoint, /RIVET_EXECUTOR_PORT="\$\{RIVET_EXECUTOR_PORT:-21889\}"/);
  assert.match(
    executorEntrypoint,
    /executor-bundle\.cjs --host "\$\{RIVET_EXECUTOR_HOST\}" --port "\$\{RIVET_EXECUTOR_PORT\}"/,
  );
  assert.doesNotMatch(executorEntrypoint, /executor-bundle\.cjs --port "\$\{PORT\}"/);

  for (const dockerfile of [executorDockerfile, composeExecutorDockerfile]) {
    assert.match(dockerfile, /COPY \. \./);
    assert.match(dockerfile, /yarn workspace @valerypopoff\/rivet-studio-server-executor run build/);
    assert.match(dockerfile, /packages\/studio-server-executor\/dist\/executor-bundle\.cjs/);
    assert.match(dockerfile, /ENV RIVET_EXECUTOR_PORT=21889/);
    assert.match(dockerfile, /ENV RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
    assert.doesNotMatch(dockerfile, /wrapper\/|\.rivet-package-links|--from=rivet_/);
  }

  assert.match(executorBundler, /studioServerExecutorDir[\s\S]*packages', 'studio-server-executor'/);
  assert.match(executorBundler, /'import\.meta\.url': '__filename'/);
  assert.match(executorHost, /startAppExecutor/);
  assert.match(executorHost, /createHttpRivetLLMProfileHealthStore/);

  for (const compose of [prodCompose, devCompose]) {
    assert.match(
      compose,
      /executor:[\s\S]*- PORT=21889[\s\S]*- RIVET_EXECUTOR_PORT=21889[\s\S]*- RIVET_EXECUTOR_HOST=0\.0\.0\.0/,
    );
    assert.match(
      compose,
      /RIVET_RUNTIME_PROCESS_ROLE=executor[\s\S]*RIVET_LLM_PROFILE_HEALTH_API_URL=http:\/\/api:80\/api\/workflows\/llm-profile-health/,
    );
    assert.match(
      compose,
      /api:[\s\S]*?- type: volume\s+source: rivet_data\s+target: \/data\/rivet-app\s+volume:\s+nocopy: true/,
    );
    assert.match(
      compose,
      /executor:[\s\S]*?- type: volume\s+source: rivet_data\s+target: \/home\/rivet\/\.local\/share\/com\.valerypopoff\.rivet2\s+volume:\s+nocopy: true/,
    );
  }
});

test('Docker launchers attach the selected dotenv only to API and executor runtimes', () => {
  const runtimeEnvCompose = readRepoFile('deploy/studio-server/compose/docker-compose.runtime-env.yml');
  const devLauncher = readRepoFile('deploy/studio-server/scripts/dev-docker.mjs');
  const prodLauncher = readRepoFile('deploy/studio-server/scripts/prod-docker.mjs');

  assert.match(runtimeEnvCompose, /services:\s*\n\s*api:\s*\n\s*env_file:\s*\n\s*- "\$\{RIVET_RUNTIME_ENV_FILE\}"/);
  assert.match(runtimeEnvCompose, /\n\s*executor:\s*\n\s*env_file:\s*\n\s*- "\$\{RIVET_RUNTIME_ENV_FILE\}"/);
  assert.doesNotMatch(runtimeEnvCompose, /\n\s*(?:web|proxy):\s*\n/);

  for (const launcher of [devLauncher, prodLauncher]) {
    assert.match(launcher, /mergedEnv\.RIVET_RUNTIME_ENV_FILE = envPath/);
    assert.match(launcher, /deploy\/studio-server\/compose\/docker-compose\.runtime-env\.yml/);
  }
  for (const launcher of [devLauncher, prodLauncher]) {
    assert.match(launcher, /config --no-interpolate --no-env-resolution --no-path-resolution/);
    assert.match(launcher, /services: \[`\$\{composeBase\} config --services`\]/);
  }
});

test('images and local launchers build directly from the monorepo workspace', () => {
  const apiDockerfile = readRepoFile('deploy/studio-server/images/api/Dockerfile');
  const webDockerfile = readRepoFile('deploy/studio-server/images/web/Dockerfile');
  const composeWebDockerfile = readRepoFile('deploy/studio-server/compose/docker/Dockerfile.web');
  const executorDockerfile = readRepoFile('deploy/studio-server/images/executor/Dockerfile');
  const apiEntrypoint = readRepoFile('deploy/studio-server/images/api/entrypoint.sh');
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const devCompose = readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml');
  const devDockerLauncher = readRepoFile('deploy/studio-server/scripts/dev-docker.mjs');
  const prodDockerLauncher = readRepoFile('deploy/studio-server/scripts/prod-docker.mjs');

  for (const dockerfile of [apiDockerfile, webDockerfile, executorDockerfile]) {
    assert.match(dockerfile, /WORKDIR \/app[\s\S]*COPY \. \./);
    assert.match(dockerfile, /yarn install --immutable/);
    assert.doesNotMatch(
      dockerfile,
      /wrapper\/|rivet_source|rivet_dependency_metadata|\.rivet-package-links|--preserve-symlinks/,
    );
  }
  assert.match(apiDockerfile, /yarn build:runtime/);
  assert.match(apiDockerfile, /yarn workspace @valerypopoff\/rivet-studio-server-api run build/);
  assert.match(webDockerfile, /yarn build:hosted-web-deps/);
  assert.match(webDockerfile, /npm install -g serve@14\.2\.6/);
  assert.match(composeWebDockerfile, /npm install -g serve@14\.2\.6/);
  assert.match(executorDockerfile, /yarn build:runtime/);
  assert.doesNotMatch(executorDockerfile, /build:executor-runtime|rivet-app-executor run build/);
  assert.match(apiEntrypoint, /exec node \/app\/packages\/studio-server-api\/dist\/studio-server-api\/src\/server\.js/);

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /context: \.\.\/\.\.\/\.\./);
    assert.match(compose, /dockerfile: deploy\/studio-server\/compose\/docker\/Dockerfile\.api/);
    assert.doesNotMatch(compose, /additional_contexts|rivet_source|rivet_dependency_metadata|\/workspace\/rivet/);
    assert.match(compose, /api:[\s\S]*healthcheck:[\s\S]*\/readyz/);
    assert.match(compose, /api:[\s\S]*stop_grace_period: 150s/);
  }
  assert.match(devCompose, /node_modules\/\.studio-server-yarn-install-ok/);
  assert.match(
    devCompose,
    /\.\/nginx\/default\.dev\.conf\.template:\/etc\/nginx\/templates\/default\.conf\.template:ro/,
  );
  assert.doesNotMatch(devCompose, /\.\.\/nginx\/default\.dev\.conf\.template/);
  assert.equal(devCompose.match(/- YARN_NODE_LINKER=node-modules/g)?.length, 2);
  assert.equal(devCompose.match(/- YARN_CHECKSUM_BEHAVIOR=ignore/g)?.length, 2);
  assert.equal(
    devCompose.match(/- YARN_INSTALL_STATE_PATH=\/workspace\/node_modules\/\.yarn-install-state\.gz/g)?.length,
    2,
  );
  assert.match(devDockerLauncher, /node_modules\/\.studio-server-yarn-install-ok/);
  assert.match(devDockerLauncher, /const composeProject = 'rivet-studio-server-dev'/);
  assert.match(devDockerLauncher, /docker compose -p \$\{composeProject\}/);
  assert.match(devDockerLauncher, /readDockerWaitTimeoutSeconds/);
  assert.match(
    prodDockerLauncher,
    /DEFAULT_PRODUCTION_COMPOSE_PROJECT = 'compose'/,
    'the production launcher must retain the historical default while detecting the other standalone volume identity',
  );
  assert.match(prodDockerLauncher, /RIVET_STUDIO_SERVER_COMPOSE_PROJECT/);
  assert.match(
    prodDockerLauncher,
    /LEGACY_PRODUCTION_COMPOSE_PROJECTS = \['ops', DEFAULT_PRODUCTION_COMPOSE_PROJECT\]/,
  );
  assert.match(prodDockerLauncher, /return `docker compose -p \$\{project\} \$\{suffix\}`/);
  assert.match(prodDockerLauncher, /readDockerWaitTimeoutSeconds/);
  assert.doesNotMatch(
    `${devDockerLauncher}\n${prodDockerLauncher}`,
    /prepareRivetDockerContext|RIVET_SOURCE_|RIVET_DEPENDENCY_/,
  );
});

test('CI and production launchers publish and run the Studio Server image set from one commit', () => {
  const imageBuildWorkflow = readRepoFile('.github/workflows/studio-server-images.yml');
  const verificationWorkflow = readRepoFile('.github/workflows/studio-server-verify.yml');
  const prodCompose = readRepoFile('deploy/studio-server/compose/docker-compose.yml');
  const prodDockerLauncher = readRepoFile('deploy/studio-server/scripts/prod-docker.mjs');
  const envExample = readRepoFile('deploy/studio-server/.env.example');
  const packageJson = readRepoJson<{
    packageManager: string;
    scripts: Record<string, string>;
  }>('package.json');
  const promotionIndex = /\r?\n  promote-images:\r?\n/.exec(imageBuildWorkflow)?.index ?? -1;

  assert.ok(promotionIndex > 0, 'expected a final image promotion job');
  assert.match(imageBuildWorkflow, /branches:\s*\n\s*- main/);
  assert.match(imageBuildWorkflow, /permissions:\s*\n\s+actions: read\s*\n\s+contents: read\s*\n\s+packages: write/);
  assert.doesNotMatch(imageBuildWorkflow, /cloud-hosted-rivet2-wrapper/);
  assert.match(verificationWorkflow, /push:\r?\n\s+branches:\r?\n\s+- develop/);
  assert.match(verificationWorkflow, /pull_request:\r?\n\s+branches:\r?\n\s+- develop/);
  assert.doesNotMatch(verificationWorkflow, /codex\/import-studio-server/);
  assert.match(verificationWorkflow, /node \.yarn\/releases\/yarn-4\.17\.1\.cjs install --immutable --immutable-cache/);
  assert.match(verificationWorkflow, /Check Out Repository[\s\S]*fetch-depth: 0/);
  assert.match(verificationWorkflow, /api-tests:[\s\S]*--shard-index \$\{\{ matrix\.shard \}\} --shard-count 4/);
  assert.match(verificationWorkflow, /host-compatibility:[\s\S]*studio-server:verify:host-compatibility/);
  assert.match(verificationWorkflow, /repository-contracts:[\s\S]*studio-server:verify:production-cutover/);
  assert.match(verificationWorkflow, /deployment-contracts:[\s\S]*studio-server:verify:kubernetes/);
  assert.match(verificationWorkflow, /\n  verify:\n[\s\S]*Require every applicable Studio Server gate/);
  assert.match(
    imageBuildWorkflow,
    /verify-repository:\n\s+uses: \.\/\.github\/workflows\/studio-server-verify\.yml\n\s+with:\n\s+force: true/,
  );
  assert.match(packageJson.scripts['studio-server:test'], /studio-server:verify:migration-ledger/);
  assert.equal(packageJson.packageManager, 'yarn@4.17.1');
  assert.equal(packageJson.scripts.preinstall, 'node scripts/checks/check-package-manager.mjs');
  assert.equal(packageJson.scripts['build:all'], 'yarn build');
  assert.equal(packageJson.scripts.prod, undefined);
  assert.match(
    imageBuildWorkflow,
    /SOURCE_TAG: candidate-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(imageBuildWorkflow, /type=raw,value=\$\{\{ env\.SOURCE_TAG \}\}/);
  assert.match(imageBuildWorkflow, /continue-on-error: true/);
  assert.match(imageBuildWorkflow, /steps\.build\.outcome == 'failure'/);
  assert.match(imageBuildWorkflow, /docker buildx imagetools create/);
  assert.match(imageBuildWorkflow, /gate_script=studio-server:verify:kubernetes:managed-live/);
  assert.match(imageBuildWorkflow, /gate_script=studio-server:verify:kubernetes:managed-disruption/);
  assert.ok(imageBuildWorkflow.includes("type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}"));
  assert.doesNotMatch(
    `${imageBuildWorkflow}\n${verificationWorkflow}`,
    /resolve-rivet|RIVET_REPO_|build-contexts|rivet_source|rivet_dependency_metadata|(?:^|\s)wrapper\//m,
  );

  for (const [service, platforms] of [
    ['proxy', 'linux/amd64,linux/arm64'],
    ['web', 'linux/amd64,linux/arm64'],
    ['api', 'linux/amd64'],
    ['executor', 'linux/amd64'],
  ] as const) {
    assert.match(
      imageBuildWorkflow,
      new RegExp(
        `- service: ${service}\\s+dockerfile: deploy/studio-server/images/${service}/Dockerfile\\s+image: ghcr\\.io/valerypopoff/rivet2\\.0-studio-server/${service}\\s+platforms: ${platforms.replace(/\//g, '\\/')}`,
      ),
    );
    assert.ok(prodCompose.includes(`ghcr.io/valerypopoff/rivet2.0-studio-server/${service}`));
    assert.ok(envExample.includes(`ghcr.io/valerypopoff/rivet2.0-studio-server/${service}:latest`));
  }

  assert.equal(packageJson.scripts['studio-server:prod'], 'yarn studio-server:prod:prebuilt');
  assert.equal(
    packageJson.scripts['studio-server:prod:prebuilt'],
    'node deploy/studio-server/scripts/prod-docker.mjs prebuilt',
  );
  assert.equal(
    packageJson.scripts['studio-server:prod:config'],
    'node deploy/studio-server/scripts/prod-docker.mjs config',
  );
  assert.equal(
    packageJson.scripts['studio-server:prod:services'],
    'node deploy/studio-server/scripts/prod-docker.mjs services',
  );
  assert.equal(
    packageJson.scripts['studio-server:prod:restart'],
    'node deploy/studio-server/scripts/prod-docker.mjs restart',
  );
  assert.equal(
    packageJson.scripts['studio-server:prod:custom'],
    'node deploy/studio-server/scripts/prod-docker.mjs custom',
  );
  assert.equal(packageJson.scripts['studio-server:dev'], 'yarn studio-server:dev:docker');
  assert.equal(packageJson.scripts['studio-server:dev:docker'], 'node deploy/studio-server/scripts/dev-docker.mjs dev');
  assert.equal(packageJson.scripts['studio-server:dev:down'], 'yarn studio-server:dev:docker:down');
  assert.equal(packageJson.scripts['studio-server:dev:recreate'], 'yarn studio-server:dev:docker:recreate');
  assert.match(prodDockerLauncher, /pull proxy web api executor/);
  assert.match(prodDockerLauncher, /--no-build --force-recreate --remove-orphans --wait/);
  assert.match(prodDockerLauncher, /--build --force-recreate --remove-orphans --wait/);
});

test('Compose explicitly initializes every writable storage mount before runtime services start', () => {
  for (const [topology, compose, expectedImage] of [
    [
      'production',
      readRepoFile('deploy/studio-server/compose/docker-compose.yml'),
      /image: \$\{RIVET_API_IMAGE:-ghcr\.io\/valerypopoff\/rivet2\.0-studio-server\/api:\$\{RIVET_IMAGE_TAG:-latest\}\}/,
    ],
    ['development', readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml'), /image: node:20-alpine/],
  ] as const) {
    const initializer = composeServiceBlock(compose, 'filesystem-artifacts-init');

    assert.match(initializer, expectedImage, `${topology} initializer image`);
    assert.match(initializer, /user: "0:0"/);
    assert.match(initializer, /entrypoint: \["\/bin\/sh", "-ec"\]/);
    assert.match(initializer, /command:\s*\n\s*- \|/);
    assert.match(
      initializer,
      /for directory in \/workflows \/workflow-recordings \/data\/runtime-libraries \/data\/rivet-app; do/,
    );
    assert.ok(initializer.includes('if [ "$$(stat -c \'%u:%g\' "$$directory")" != "10001:10001" ]; then'));
    assert.ok(initializer.includes('find "$$directory" -xdev -exec chown -h 10001:10001 {} +'));
    assert.match(initializer, /RIVET_WORKFLOWS_HOST_PATH.*:\/workflows/);
    assert.match(initializer, /RIVET_WORKFLOW_RECORDINGS_HOST_PATH.*:\/workflow-recordings/);
    assert.match(initializer, /RIVET_RUNTIME_LIBS_HOST_PATH.*:\/data\/runtime-libraries/);
    assert.match(
      initializer,
      /- type: volume\s+source: rivet_data\s+target: \/data\/rivet-app\s+volume:\s+nocopy: true/,
    );
    assert.match(initializer, /restart: "no"/);
    assert.doesNotMatch(initializer, /rivet_workspace|\/workspace/);

    for (const service of ['api', 'executor']) {
      assert.match(
        composeServiceBlock(compose, service),
        /depends_on:[\s\S]*?\n\s*filesystem-artifacts-init:\s*\n\s*condition: service_completed_successfully/,
      );
    }
  }
});

test('Compose and candidate smoke keep metrics enabled only on the direct API path', () => {
  const composeTopologies = [
    ['production', readRepoFile('deploy/studio-server/compose/docker-compose.yml')],
    ['development', readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml')],
  ] as const;
  const candidateSmoke = readRepoFile('deploy/studio-server/scripts/candidate-image-smoke.mjs');

  for (const [topology, compose] of composeTopologies) {
    assert.match(
      composeServiceBlock(compose, 'api'),
      /RIVET_METRICS_ENABLED=\$\{RIVET_METRICS_ENABLED:-false\}/,
      `${topology} API enables metrics only through the explicit opt-in`,
    );
    assert.doesNotMatch(composeServiceBlock(compose, 'proxy'), /RIVET_METRICS_ENABLED/);
    assert.doesNotMatch(composeServiceBlock(compose, 'executor'), /RIVET_METRICS_ENABLED/);
  }

  assert.match(candidateSmoke, /RIVET_METRICS_ENABLED: 'true'/);
  assert.match(
    candidateSmoke,
    /async function assertDirectApiMetrics\([\s\S]*?http:\/\/127\.0\.0\.1:80\/metrics[\s\S]*?\[\.\.\.composeArgs, 'exec', '-T', 'api', 'node', '-e', probeScript\]/,
  );
  assert.match(candidateSmoke, /await assertDirectApiMetrics\(composeArgs, env\);/);
});
