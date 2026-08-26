import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractBracedBlock,
  readRepoFile,
  readRepoJson,
} from './helpers/repo-contract-helpers.js';

const proxyTemplatePaths = [
  'image/proxy/default.conf.template',
  'ops/nginx/default.conf.template',
  'ops/nginx/default.dev.conf.template',
] as const;

function readProxyTemplates(): string[] {
  return proxyTemplatePaths.map((templatePath) => readRepoFile(templatePath));
}

function proxyLocation(template: string, locationPattern: RegExp): string {
  return extractBracedBlock(template, locationPattern);
}

test('proxy templates route public workflow traffic to the right API plane', () => {
  const imageProxyTemplate = readRepoFile('image/proxy/default.conf.template');
  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');

  assert.match(proxyLocation(imageProxyTemplate, /location = \/__rivet_auth\s*\{/), /proxy_pass \$api_ui_auth_upstream;/);
  assert.match(proxyLocation(imageProxyTemplate, /location \/api\/\s*\{/), /proxy_pass \$api_upstream;/);
  assert.match(imageProxyTemplate, /include \$\{RIVET_PUBLIC_ROUTES_INCLUDE_FILE\};/);
  assert.match(proxyBootstrap, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /location \$\{RIVET_WEB_APPS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /location \$\{RIVET_LATEST_WEB_APPS_BASE_PATH\}\/ \{/);
  assert.match(proxyBootstrap, /proxy_pass \\\$execution_upstream;[\s\S]*proxy_pass \\\$execution_upstream;[\s\S]*proxy_pass \\\$api_upstream;[\s\S]*proxy_pass \\\$api_upstream;/);
  assert.match(proxyBootstrap, /location ~ \^\$\{RIVET_WEB_APPS_BASE_PATH\}\/\[\^\/\]\+\/actions\/ws\$ \{/);
  assert.match(proxyBootstrap, /location ~ \^\$\{RIVET_LATEST_WEB_APPS_BASE_PATH\}\/\[\^\/\]\+\/actions\/ws\$ \{/);
  assert.match(proxyBootstrap, /actions\/ws\$ \{[\s\S]*?proxy_pass \\\$execution_upstream;[\s\S]*?proxy_set_header Upgrade \\\$http_upgrade;[\s\S]*?proxy_read_timeout 86400s;[\s\S]*?proxy_buffering off;/);
  assert.match(proxyBootstrap, /actions\/ws\$ \{[\s\S]*?proxy_pass \\\$api_upstream;[\s\S]*?proxy_set_header Upgrade \\\$http_upgrade;[\s\S]*?proxy_read_timeout 86400s;[\s\S]*?proxy_buffering off;/);

  const latestDebuggerLocation = proxyLocation(imageProxyTemplate, /location \/ws\/latest-debugger\s*\{/);
  assert.match(imageProxyTemplate, /set \$api_latest_debugger_upstream http:\/\/\$\{RIVET_API_UPSTREAM_HOST\}:\$\{RIVET_API_UPSTREAM_PORT\}\/ws\/latest-debugger;/);
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
  assert.doesNotMatch(proxyBootstrap, /export RIVET_PROXY_SETTINGS_FILE="\$\{RIVET_PROXY_SETTINGS_FILE:-\/tmp\/nginx\/rivet-proxy-settings\.json\}"/);
  assert.match(proxyBootstrap, /public_route_settings_file="\$\{RIVET_PROXY_SETTINGS_FILE:-\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/public-routes\.json\}"/);
  assert.match(proxyBootstrap, /trusted_host_settings_file="\$\{RIVET_PROXY_SETTINGS_FILE:-\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/trusted-hosts\.json\}"/);
  assert.match(proxyBootstrap, /legacy_web_app_route_settings_file="\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/web-app-routes\.json"/);
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
  assert.doesNotMatch(proxyBootstrap, /RIVET_PUBLIC_ROUTES_INCLUDE_FILE:-\$NGINX_ENVSUBST_OUTPUT_DIR\/rivet-public-routes\.conf/);
  assert.match(proxyBootstrap, /write_trusted_hosts_include\(\)/);
  assert.match(proxyBootstrap, /trustedHostsCsv/);
  assert.match(proxyBootstrap, /nginx -t/);
  assert.match(proxyBootstrap, /nginx -s reload/);
  assert.match(proxyBootstrap, /export RIVET_PROXY_RESOLVER="\$\(resolve_proxy_resolver "\$\{RIVET_PROXY_RESOLVER:-\}"\)"/);
});

test('proxy UI gate prompt is API-rendered and receives the original route', () => {
  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');
  const proxyDockerfile = readRepoFile('image/proxy/Dockerfile');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  for (const template of readProxyTemplates()) {
    const rootLocation = proxyLocation(template, /location \/\s*\{/);
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
  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');
  const managedCompose = readRepoFile('ops/compose/docker-compose.managed-services.yml');
  assert.doesNotMatch(proxyBootstrap, /normalize_web_apps_auth_mode\(\)/);
  assert.match(proxyBootstrap, /RIVET_TRUST_INCOMING_FORWARDED_HEADERS="\$\(normalize_bool "\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-\}" "0"\)"/);
  assert.doesNotMatch(proxyBootstrap, /RIVET_WEB_APPS_AUTH_MODE/);
  assert.match(prodCompose, /RIVET_TRUST_INCOMING_FORWARDED_HEADERS=\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-false\}/);
  assert.match(devCompose, /RIVET_TRUST_INCOMING_FORWARDED_HEADERS=\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-false\}/);
  assert.doesNotMatch(prodCompose, /RIVET_UI_TOKEN_FREE_HOSTS/);
  assert.doesNotMatch(devCompose, /RIVET_UI_TOKEN_FREE_HOSTS/);
  assert.match(prodCompose, /RIVET_CORS_ALLOWED_ORIGINS=\$\{RIVET_CORS_ALLOWED_ORIGINS:-\}/);
  assert.match(devCompose, /RIVET_CORS_ALLOWED_ORIGINS=\$\{RIVET_CORS_ALLOWED_ORIGINS:-\}/);
  assert.match(prodCompose, /RIVET_APP_DATA_ROOT=\/data\/rivet-app[\s\S]*rivet_data:\/data\/rivet-app:ro/);
  assert.match(devCompose, /RIVET_APP_DATA_ROOT=\/data\/rivet-app[\s\S]*rivet_data:\/data\/rivet-app:ro/);
  assert.match(devCompose, /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_API_PORT:-3100\}:80"/);
  assert.match(managedCompose, /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_WORKFLOWS_LOCAL_DOCKER_POSTGRES_PORT:-54329\}:5432"/);
  assert.match(managedCompose, /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_WORKFLOWS_LOCAL_DOCKER_OBJECT_STORAGE_PORT:-9000\}:9000"/);
  assert.match(managedCompose, /"\$\{RIVET_LOCAL_BIND_HOST:-127\.0\.0\.1\}:\$\{RIVET_WORKFLOWS_LOCAL_DOCKER_OBJECT_STORAGE_CONSOLE_PORT:-9001\}:9001"/);
  const retiredAuthEnvPattern =
    /RIVET_WEB_APPS_AUTH_MODE|RIVET_SERVER_UI_OAUTH_|(^|\W)OAUTH_PROVIDER|(^|\W)OAUTH_CLIENT_SECRET|(^|\W)OAUTH_DEBUG_LOG_PROFILE/;
  assert.doesNotMatch(prodCompose, retiredAuthEnvPattern);
  assert.doesNotMatch(devCompose, retiredAuthEnvPattern);

  for (const template of readProxyTemplates()) {
    assert.match(template, /map "\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS\}:\$http_x_forwarded_host" \$rivet_forwarded_host/);
    assert.match(template, /default \$http_host;/);
    assert.match(template, /\~\^1:\(\.\+\)\$ \$1;/);
    assert.match(template, /map \$rivet_forwarded_host \$rivet_forwarded_hostname/);
    assert.ok(template.includes('~^\\[(?<ipv6_host>[^\\]]+)\\](?::\\d+)?$ $ipv6_host;'));
    assert.ok(template.includes('~^(?<plain_host>[^:]+):\\d+$ $plain_host;'));
    assert.match(template, /map "\$\{RIVET_TRUST_INCOMING_FORWARDED_HEADERS\}:\$http_x_forwarded_proto" \$rivet_forwarded_proto/);
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
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  assert.equal((devCompose.match(/host\.docker\.internal:host-gateway/g) ?? []).length, 2);
  assert.equal(
    (devCompose.match(/RIVET_NODE_EXECUTOR_PROXY_BYPASS_HOSTS=\$\{RIVET_NODE_EXECUTOR_PROXY_BYPASS_HOSTS:-\}/g) ?? []).length,
    2,
  );
});

test('compose fallback artifact mounts stay isolated under app data', () => {
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /\$\{RIVET_WORKFLOWS_HOST_PATH:-\.\.\/\.\.\/\.data\/workflows\}:\/workflows/);
    assert.match(
      compose,
      /\$\{RIVET_WORKFLOW_RECORDINGS_HOST_PATH:-\.\.\/\.\.\/\.data\/workflow-recordings\}:\/workflow-recordings/,
    );
    assert.match(compose, /\$\{RIVET_RUNTIME_LIBS_HOST_PATH:-\.\.\/\.\.\/\.data\/runtime-libraries\}:\/data\/runtime-libraries/);
    assert.doesNotMatch(compose, /\$\{RIVET_WORKFLOWS_HOST_PATH:-\.\.\/\.\.\/workflows\}:\/workflows/);
    assert.doesNotMatch(compose, /\$\{RIVET_WORKFLOW_RECORDINGS_HOST_PATH:-\.\.\/\.\.\/workflow-recordings\}:\/workflow-recordings/);
  }
});

test('proxy templates keep HTTP workflow routes bounded and websocket routes long-lived', () => {
  const proxyDockerfile = readRepoFile('image/proxy/Dockerfile');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  for (const template of readProxyTemplates()) {
    for (const locationPattern of [/location \/api\/\s*\{/]) {
      const location = proxyLocation(template, locationPattern);
      assert.match(location, /include \$\{RIVET_PROXY_TIMEOUT_INCLUDE_FILE\};/);
    }

    assert.match(proxyLocation(template, /location \/ws\/latest-debugger\s*\{/), /proxy_read_timeout 86400s;/);
    assert.match(proxyLocation(template, /location \/ws\/executor\/internal\s*\{/), /proxy_read_timeout 86400s;/);
  }

  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');
  assert.match(proxyBootstrap, /runtime_limit_settings_file="\$\{RIVET_PROXY_SETTINGS_FILE:-\$\{RIVET_APP_DATA_ROOT:-\/data\/rivet-app\}\/settings\/runtime-limits\.json\}"/);
  assert.match(proxyBootstrap, /read_json_scalar_property "\$runtime_limit_settings_file" "proxyReadTimeoutSeconds"/);
  assert.match(proxyBootstrap, /read_json_scalar_property "\$runtime_limit_settings_file" "webAppActionRequestLimitBytes"/);
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
  const executorEntrypoint = readRepoFile('image/executor/entrypoint.sh');
  const executorDockerfile = readRepoFile('image/executor/Dockerfile');
  const executorBundler = readRepoFile('wrapper/executor/build/bundle-executor.cjs');
  const executorHost = readRepoFile('wrapper/executor/src/executor.mts');
  const composeExecutorDockerfile = readRepoFile('ops/docker/Dockerfile.executor');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  assert.match(executorEntrypoint, /RIVET_EXECUTOR_PORT="\$\{RIVET_EXECUTOR_PORT:-21889\}"/);
  assert.match(executorEntrypoint, /RIVET_EXECUTOR_HOST="\$\{RIVET_EXECUTOR_HOST:-0\.0\.0\.0\}"/);
  assert.match(executorEntrypoint, /executor-bundle\.cjs --host "\$\{RIVET_EXECUTOR_HOST\}" --port "\$\{RIVET_EXECUTOR_PORT\}"/);
  assert.doesNotMatch(executorEntrypoint, /executor-bundle\.cjs --port "\$\{PORT\}"/);
  assert.match(executorDockerfile, /ENV RIVET_EXECUTOR_PORT=21889/);
  assert.match(executorDockerfile, /ENV RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
  assert.match(executorDockerfile, /ENV RIVET_CODE_RUNNER_REQUIRE_ROOT=\/data\/runtime-libraries\/current\/node_modules/);
  assert.match(executorDockerfile, /COPY wrapper\/executor\/src\/ \/app\/wrapper\/executor\/src\//);
  assert.match(executorDockerfile, /COPY wrapper\/shared\/llmProfileHealthHttpStore\.ts \/app\/wrapper\/shared\/llmProfileHealthHttpStore\.ts/);
  assert.doesNotMatch(executorDockerfile, /ENV PORT=21889/);
  assert.match(composeExecutorDockerfile, /ENV RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
  assert.match(composeExecutorDockerfile, /ENV RIVET_CODE_RUNNER_REQUIRE_ROOT=\/data\/runtime-libraries\/current\/node_modules/);
  assert.match(composeExecutorDockerfile, /COPY wrapper\/executor\/src\/ \/app\/wrapper\/executor\/src\//);
  assert.match(composeExecutorDockerfile, /COPY wrapper\/shared\/llmProfileHealthHttpStore\.ts \/app\/wrapper\/shared\/llmProfileHealthHttpStore\.ts/);
  assert.ok(composeExecutorDockerfile.includes('node executor-bundle.cjs --host \\"${RIVET_EXECUTOR_HOST}\\" --port 21889'));
  assert.match(executorBundler, /'import\.meta\.url': '__filename'/);
  assert.match(executorBundler, /wrapperExecutorDir[\s\S]*src', 'executor\.mts'/);
  assert.match(executorHost, /startAppExecutor/);
  assert.match(executorHost, /createHttpRivetLLMProfileHealthStore/);
  assert.match(executorHost, /llmProfileHealthStore: healthStore/);

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /executor:[\s\S]*- PORT=21889[\s\S]*- RIVET_EXECUTOR_PORT=21889[\s\S]*- RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
    assert.match(compose, /OPENAI_ENDPOINT=\$\{OPENAI_ENDPOINT:-\}\r?\n\s*- PINECONE_API_KEY=\$\{PINECONE_API_KEY:-\}/);
    assert.match(compose, /RIVET_RUNTIME_PROCESS_ROLE=executor[\s\S]*RIVET_KEY=\$\{RIVET_KEY:-\}[\s\S]*RIVET_LLM_PROFILE_HEALTH_API_URL=http:\/\/api:80\/api\/workflows\/llm-profile-health[\s\S]*RIVET_EXECUTION_ENVIRONMENT_API_URL=http:\/\/api:80\/api\/workflows\/execution-environment[\s\S]*PINECONE_API_KEY=\$\{PINECONE_API_KEY:-\}/);
    assert.equal((compose.match(/^\s*- PINECONE_API_KEY=\$\{PINECONE_API_KEY:-\}$/gm) ?? []).length, 2);
    assert.match(compose, /- HOME=\/home\/rivet/);
    assert.match(compose, /- npm_config_cache=\/home\/rivet\/\.npm/);
    assert.match(compose, /- YARN_CACHE_FOLDER=\/home\/rivet\/\.cache\/yarn/);
    assert.match(compose, /\/home\/rivet\/\.local\/share\/com\.valerypopoff\.rivet2/);
    assert.doesNotMatch(compose, /\/root\/\.npm|\/root\/\.cache\/yarn|HOME=\/root|\/root\/\.local\/share\/com\.valerypopoff\.rivet2/);
  }
});

test('Docker launchers attach the selected dotenv only to API and executor runtimes', () => {
  const runtimeEnvCompose = readRepoFile('ops/compose/docker-compose.runtime-env.yml');
  const devLauncher = readRepoFile('scripts/dev-docker.mjs');
  const prodLauncher = readRepoFile('scripts/prod-docker.mjs');

  assert.match(runtimeEnvCompose, /services:\s*\n\s*api:\s*\n\s*env_file:\s*\n\s*- "\$\{RIVET_RUNTIME_ENV_FILE\}"/);
  assert.match(runtimeEnvCompose, /\n\s*executor:\s*\n\s*env_file:\s*\n\s*- "\$\{RIVET_RUNTIME_ENV_FILE\}"/);
  assert.doesNotMatch(runtimeEnvCompose, /\n\s*(?:web|proxy):\s*\n/);

  for (const launcher of [devLauncher, prodLauncher]) {
    assert.match(launcher, /mergedEnv\.RIVET_RUNTIME_ENV_FILE = envPath/);
    assert.match(launcher, /-f ops\/compose\/docker-compose\.runtime-env\.yml/);
  }
  assert.match(devLauncher, /config --no-interpolate --no-env-resolution --no-path-resolution/);
});

test('API images and launchers use the filtered Rivet source context and symlink-preserved runtime links', () => {
  const apiDockerfile = readRepoFile('image/api/Dockerfile');
  const apiEntrypoint = readRepoFile('image/api/entrypoint.sh');
  const executorDockerfile = readRepoFile('image/executor/Dockerfile');
  const webDockerfile = readRepoFile('image/web/Dockerfile');
  const composeApiDockerfile = readRepoFile('ops/docker/Dockerfile.api');
  const composeExecutorDockerfile = readRepoFile('ops/docker/Dockerfile.executor');
  const composeWebDockerfile = readRepoFile('ops/docker/Dockerfile.web');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');
  const devDockerLauncher = readRepoFile('scripts/dev-docker.mjs');
  const prodDockerLauncher = readRepoFile('scripts/prod-docker.mjs');
  const dockerLauncherHelper = readRepoFile('scripts/lib/docker-launcher.mjs');
  const rivetContextHelper = readRepoFile('scripts/lib/rivet-source-context.mjs');
  const ensureRivetRuntimeBuild = readRepoFile('scripts/ensure-rivet-runtime-build.mjs');
  const linkScript = readRepoFile('scripts/link-rivet-node-package.mjs');
  const ensureDevDeps = readRepoFile('scripts/ensure-dev-deps.mjs');
  const localDependencyPolicy = readRepoFile('scripts/lib/rivet-local-dependencies.mjs');
  const apiPackageJson = readRepoFile('wrapper/api/package.json');
  const apiTsconfig = readRepoFile('wrapper/api/tsconfig.json');
  const preserveSymlinksRunner = readRepoFile('scripts/run-preserve-symlinks.mjs');

  assert.doesNotMatch(apiEntrypoint, /\r/, 'API entrypoint must keep Unix LF line endings');

  for (const dockerfile of [apiDockerfile, composeApiDockerfile]) {
    assert.match(dockerfile, /COPY --from=rivet_dependency_metadata \. rivet\//);
    assert.match(dockerfile, /COPY --from=rivet_source \. \/app\/rivet\//);
    assert.match(dockerfile, /YARN_NODE_LINKER=node-modules yarn build:runtime/);
    assert.match(dockerfile, /YARN_NODE_LINKER=node-modules yarn build:hosted-web-deps/);
    assert.doesNotMatch(dockerfile, /yarn workspace @valerypopoff\/rivet2-(core|node) run build/);
    assert.match(dockerfile, /RUN node \/app\/scripts\/link-rivet-node-package\.mjs/);
    assert.match(dockerfile, /COPY scripts\/lib\/rivet-local-dependencies\.mjs scripts\/lib\/rivet-local-dependencies\.d\.mts scripts\/lib\//);
    assert.match(dockerfile, /COPY scripts\/lib\/kubernetes-managed-release-gate-config\.mjs scripts\/lib\/kubernetes-managed-release-gate-config\.d\.mts scripts\/lib\//);
    assert.match(dockerfile, /COPY scripts\/lib\/kubernetes-managed-provider-gate-config\.mjs scripts\/lib\/kubernetes-managed-provider-gate-config\.d\.mts scripts\/lib\//);
  }

  for (const dockerfile of [
    apiDockerfile,
    executorDockerfile,
    webDockerfile,
    composeApiDockerfile,
    composeExecutorDockerfile,
    composeWebDockerfile,
  ]) {
    assert.match(dockerfile, /corepack enable/);
    assert.doesNotMatch(dockerfile, /corepack prepare yarn@/);
  }

  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/node_modules \/app\/rivet\/node_modules/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/core \/app\/rivet\/packages\/core/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/node \/app\/rivet\/packages\/node/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/evaluations \/app\/rivet\/packages\/evaluations/);
  assert.match(linkScript, /const dependencyNodeModulesRoots = \[/);
  assert.match(linkScript, /function ensureRuntimeDependenciesReady\(\)/);
  assert.match(linkScript, /function createDependencyOverlay\(pkg, packageLinkDir\)/);
  assert.match(linkScript, /\.rivet-dependency-overlay/);
  assert.match(linkScript, /getLocalRivetPackageNames\(\)/);
  assert.match(linkScript, /function removeRetiredPackageAliases\(\)/);
  assert.match(linkScript, /\.rivet-package-links/);
  assert.match(linkScript, /linkDependencyEntriesFromRoot\(dependencyRoot, destinationNodeModulesDir, skippedPackageNames\)/);
  assert.match(ensureDevDeps, /hasExpectedApiRivetLink\('rivet-core', 'rivet\/packages\/core', \[/);
  assert.match(ensureDevDeps, /hasExpectedApiRivetLink\('rivet-node', 'rivet\/packages\/node', \[/);
  assert.match(ensureDevDeps, /const rivetYarnEnvironment = getRivetYarnEnvironment\(rootDir, rivetDir\);/);
  for (const packageName of ['rivet2-core', 'rivet2-node', 'rivet2-evaluations']) {
    assert.match(
      ensureDevDeps,
      new RegExp(`@valerypopoff/${packageName}', 'run', 'build'\\], rivetDir, rivetYarnEnvironment\\);`),
    );
  }
  assert.match(ensureRivetRuntimeBuild, /getRivetYarnEnvironment\(rootDir, rivetRootDir\)/);
  assert.match(localDependencyPolicy, /isExternalRivetWorkspace/);
  assert.match(localDependencyPolicy, /YARN_NODE_LINKER: 'node-modules'/);
  assert.match(ensureDevDeps, /'\.rivet-dependency-overlay'/);
  assert.match(ensureDevDeps, /!exists\('wrapper\/web\/node_modules\/\.bin\/vite'\)/);
  assert.match(ensureDevDeps, /path\.join\('rivet\/node_modules', packageNameToNodeModulesRelPath\(dependencyName\)\)/);

  assert.match(apiTsconfig, /"preserveSymlinks": true/);
  assert.match(apiPackageJson, /run-preserve-symlinks\.mjs tsx/);
  assert.match(apiPackageJson, /node --preserve-symlinks dist\/api\/src\/server\.js/);
  assert.match(preserveSymlinksRunner, /--preserve-symlinks/);
  assert.match(apiEntrypoint, /load_optional_dotenv \/vault\/dotenv/);
  assert.match(
    apiEntrypoint,
    /deployment_managed_workflow_schema_mode="\$\{RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE:-\}"[\s\S]*load_optional_dotenv \/vault\/dotenv[\s\S]*RIVET_MANAGED_WORKFLOW_SCHEMA_MODE="\$deployment_managed_workflow_schema_mode"/,
  );
  assert.match(
    apiEntrypoint,
    /deployment_health_refresh_seconds="\$\{RIVET_DEPLOYMENT_HEALTH_REFRESH_SECONDS:-\}"[\s\S]*load_optional_dotenv \/vault\/dotenv[\s\S]*apply_deployment_lifecycle_value RIVET_HEALTH_REFRESH_SECONDS "\$deployment_health_refresh_seconds"/,
  );
  assert.match(apiEntrypoint, /apply_deployment_lifecycle_value RIVET_SHUTDOWN_GRACE_SECONDS "\$deployment_shutdown_grace_seconds"/);
  assert.match(apiEntrypoint, /exec node --preserve-symlinks \/app\/wrapper\/api\/dist\/api\/src\/server\.js/);
  assert.match(composeApiDockerfile, /node --preserve-symlinks dist\/api\/src\/server\.js/);

  for (const compose of [prodCompose, devCompose]) {
    assert.match(
      compose,
      /additional_contexts:\s*\n\s*rivet_source: \$\{RIVET_SOURCE_BUILD_CONTEXT_PATH:-\.\.\/\.\.\/rivet\}\s*\n\s*rivet_dependency_metadata: \$\{RIVET_DEPENDENCY_BUILD_CONTEXT_PATH:-\.\.\/\.\.\/rivet\}/,
    );
  }
  assert.match(devCompose, /api:[\s\S]*- rivet_node_modules:\/workspace\/rivet\/node_modules/);
  assert.match(devCompose, /web:[\s\S]*- rivet_yarn_unplugged:\/workspace\/rivet\/\.yarn\/unplugged/);
  assert.match(devCompose, /api:[\s\S]*- rivet_yarn_unplugged:\/workspace\/rivet\/\.yarn\/unplugged/);
  assert.match(devCompose, /node_modules\/\.rivet-dev-yarn-install-ok/);
  assert.match(devCompose, /\[ ! -f \.yarn\/unplugged\/\.rivet-dev-yarn-install-ok \]/);
  assert.match(devCompose, /\.yarn\/unplugged\/\.rivet-dev-yarn-install-ok/);
  assert.match(devDockerLauncher, /rivet\/\.yarn\/unplugged\/\.rivet-dev-yarn-install-ok/);
  assert.match(devDockerLauncher, /packages\/core\/dist\/esm\/index\.js/);
  assert.match(devDockerLauncher, /packages\/node\/dist\/esm\/index\.js/);
  assert.match(devDockerLauncher, /packages\/node\/dist\/esm\/webAppHandler\.js/);
  assert.match(devCompose, /cp -R \/workspace\/rivet\/packages\/evaluations \/tmp\/rivet-source\/packages\/evaluations/);
  assert.match(devCompose, /RIVET_SOURCE_ROOT=\/workspace\/rivet node \/workspace\/scripts\/ensure-rivet-runtime-build\.mjs/);
  assert.match(devCompose, /RIVET_SOURCE_ROOT=\/tmp\/rivet-source RIVET_API_PACKAGE_ROOT=\/app node \/workspace\/scripts\/link-rivet-node-package\.mjs/);
  assert.match(ensureRivetRuntimeBuild, /function getConfiguredYarnPath\(\)/);
  assert.match(ensureRivetRuntimeBuild, /\.yarnrc\.yml/);
  assert.match(ensureRivetRuntimeBuild, /Expected yarnPath/);
  assert.doesNotMatch(ensureRivetRuntimeBuild, /yarn-4\.6\.0\.cjs/);
  assert.doesNotMatch(devCompose, /corepack prepare yarn@/);
  assert.match(ensureRivetRuntimeBuild, /'build:runtime'/);
  assert.match(ensureRivetRuntimeBuild, /'build:hosted-web-deps'/);
  assert.match(ensureRivetRuntimeBuild, /webAppHandler\.js/);
  assert.match(prodCompose, /api:[\s\S]*healthcheck:[\s\S]*start_period: 360s/);
  assert.match(prodCompose, /api:[\s\S]*healthcheck:[\s\S]*retries: 12/);
  assert.match(devCompose, /api:[\s\S]*healthcheck:[\s\S]*start_period: 360s/);
  assert.match(devCompose, /api:[\s\S]*healthcheck:[\s\S]*retries: 12/);
  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /api:[\s\S]*healthcheck:[\s\S]*\/readyz/);
    assert.match(compose, /api:[\s\S]*stop_grace_period: 150s/);
  }
  assert.match(devDockerLauncher, /prepareRivetDockerContext\(rootDir, mergedEnv\)/);
  assert.match(devDockerLauncher, /readDockerWaitTimeoutSeconds/);
  assert.match(prodDockerLauncher, /readDockerWaitTimeoutSeconds/);
  assert.doesNotMatch(devDockerLauncher, /RIVET_DOCKER_WAIT_TIMEOUT/);
  assert.doesNotMatch(prodDockerLauncher, /RIVET_DOCKER_WAIT_TIMEOUT/);
  assert.match(dockerLauncherHelper, /settings\/runtime-limits\.json/);
  assert.match(dockerLauncherHelper, /dockerWaitTimeoutSeconds/);
  assert.match(devDockerLauncher, /refreshRunningProxy = action === 'dev' && proxyAlreadyRunning/);
  assert.match(devDockerLauncher, /up -d --no-deps --force-recreate --wait --wait-timeout \$\{waitTimeoutSeconds\} proxy/);
  assert.match(devDockerLauncher, /\/app\/package-lock\.json/);
  assert.match(devDockerLauncher, /Recreating \$\{service\} because dependency markers changed/);
  assert.match(prodDockerLauncher, /prepareRivetDockerContext\(rootDir, mergedEnv\)/);
  assert.ok(rivetContextHelper.includes("const defaultContextRelPath = path.join(contextRootRelPath, 'rivet-source');"));
  assert.match(rivetContextHelper, /'\.upstream-version'/);
  assert.ok(
    rivetContextHelper.includes(
      "const defaultDependencyContextRelPath = path.join(contextRootRelPath, 'rivet-dependency-metadata');",
    ),
  );
  assert.match(rivetContextHelper, /function assertDistinctPaths\(firstPath, secondPath, firstLabel, secondLabel\)/);
  assert.match(rivetContextHelper, /function copyWorkspacePackageJsonFiles\(sourceRoot, destinationRoot\)/);
  assert.match(rivetContextHelper, /const requiredRootScripts = \[['"]build:runtime['"], ['"]build:hosted-web-deps['"]\]/);
  assert.match(rivetContextHelper, /const sourceOnlyDirectories = \[['"]scripts['"]\]/);
  assert.match(rivetContextHelper, /scripts['"], ['"]build-wrapper-target\.mjs/);
  assert.match(rivetContextHelper, /packages['"], ['"]app['"], ['"]package\.json/);
  assert.match(rivetContextHelper, /packages['"], ['"]app-executor['"], ['"]package\.json/);
  assert.match(rivetContextHelper, /packages['"], ['"]evaluations['"], ['"]package\.json/);
  assert.doesNotMatch(rivetContextHelper, /visit\(''\)/);
  assert.match(rivetContextHelper, /Excluded dependency folders, build output, VCS data, and Yarn cache artifacts/);
});

test('CI and production launchers publish and run the Rivet 2 wrapper image set', () => {
  const imageBuildWorkflow = readRepoFile('.github/workflows/build-images.yml');
  const developVerificationWorkflow = readRepoFile('.github/workflows/verify-develop.yml');
  const bootstrapRivet = readRepoFile('scripts/bootstrap-rivet.mjs');
  const ensureDevDeps = readRepoFile('scripts/ensure-dev-deps.mjs');
  const webDockerfile = readRepoFile('image/web/Dockerfile');
  const webPackageJson = readRepoFile('wrapper/web/package.json');
  const webPackageLock = readRepoFile('wrapper/web/package-lock.json');
  const apiDockerfile = readRepoFile('image/api/Dockerfile');
  const executorDockerfile = readRepoFile('image/executor/Dockerfile');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const prodDockerLauncher = readRepoFile('scripts/prod-docker.mjs');
  const proxyDockerfile = readRepoFile('image/proxy/Dockerfile');
  const envExample = readRepoFile('.env.example');
  const packageJson = readRepoJson<{ scripts: Record<string, string> }>('package.json');
  const productionScripts = Object.keys(packageJson.scripts)
    .filter((scriptName) => scriptName === 'prod' || scriptName.startsWith('prod:'))
    .sort();
  const promotionIndex = /\r?\n  promote-images:\r?\n/.exec(imageBuildWorkflow)?.index ?? -1;
  assert.ok(promotionIndex > 0, 'expected a final image promotion job');
  const imageBuildPhase = imageBuildWorkflow.slice(0, promotionIndex);
  const imagePromotionPhase = imageBuildWorkflow.slice(promotionIndex);
  const legacyRepoPattern = new RegExp('Iron' + 'clad\\/rivet');
  const legacyImageNamespacePattern = new RegExp('cloud-hosted-' + 'rivet-wrapper');

  const imagePushBranches = /on:\s*\n\s*push:\s*\n\s*branches:\s*\n((?:\s*-\s+[^\n]+\n?)+)/.exec(imageBuildWorkflow)?.[1] ?? '';
  const developPushBranches = /on:\s*\n\s*push:\s*\n\s*branches:\s*\n((?:\s*-\s+[^\n]+\n?)+)/.exec(developVerificationWorkflow)?.[1] ?? '';
  assert.equal(imagePushBranches.trim(), '- main-rivet2');
  assert.equal(developPushBranches.trim(), '- develop-rivet2');
  assert.match(developVerificationWorkflow, /node-version: 20/);
  assert.match(developVerificationWorkflow, /^\s*run: npm run setup:k8s-tools\s*$/m);
  assert.match(developVerificationWorkflow, /^\s*run: npm run test\s*$/m);
  assert.doesNotMatch(developVerificationWorkflow, /^\s*run: npm run setup(?::rivet)?\s*$/m);
  assert.doesNotMatch(developVerificationWorkflow, /docker\/(build-push|login|metadata)-action|kind create cluster|ghcr\.io/);
  assert.ok(imageBuildWorkflow.includes('RIVET_REPO_URL: https://github.com/valerypopoff/rivet2.0.git'));
  assert.ok(imageBuildWorkflow.includes('RIVET_REPO_REF: main'));
  for (const actionRef of [
    'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130',
    'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
    'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
    'docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051',
    'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
  ]) {
    assert.ok(imageBuildWorkflow.includes(`uses: ${actionRef}`), actionRef);
  }
  assert.match(imageBuildWorkflow, /concurrency:\s*\n\s*group: build-images-\$\{\{ github\.ref \}\}/);
  assert.match(imageBuildWorkflow, /cancel-in-progress: false/);
  assert.match(imageBuildWorkflow, /verify-repository:[\s\S]*npm run verify:repo-structure/);
  assert.match(imageBuildWorkflow, /verify-repository:[\s\S]*npm run verify:test-style/);
  assert.equal((imageBuildWorkflow.match(/run: npm run verify:repo-structure/g) ?? []).length, 1);
  assert.equal((imageBuildWorkflow.match(/run: npm run verify:test-style/g) ?? []).length, 1);
  assert.match(imageBuildWorkflow, /build-and-push:\s*\n\s*needs:\s*\n\s*- resolve-rivet\s*\n\s*- verify-repository/);
  assert.match(imageBuildWorkflow, /needsRivet: false/);
  assert.match(imageBuildWorkflow, /if: \$\{\{ matrix\.needsRivet \}\}/);
  assert.match(imageBuildWorkflow, /build-contexts:\s*\|\s*\n\s*rivet_source=\$\{\{ matrix\.rivetSourceContext \}\}/);
  assert.match(imageBuildWorkflow, /rivet_dependency_metadata=\$\{\{ matrix\.rivetDependencyContext \}\}/);
  assert.match(imageBuildWorkflow, /rivetSourceContext: \.data\/docker-contexts\/rivet-source/);
  assert.match(imageBuildWorkflow, /rivetDependencyContext: \.data\/docker-contexts\/rivet-dependency-metadata/);
  assert.match(imageBuildWorkflow, /org\.opencontainers\.image\.rivet\.revision=\$\{\{ needs\.resolve-rivet\.outputs\.rivet_commit \}\}/);
  assert.match(imageBuildWorkflow, /push: true/);
  assert.ok(
    imageBuildWorkflow.includes('SOURCE_TAG: build-${{ github.sha }}-${{ needs.resolve-rivet.outputs.rivet_commit }}'),
  );
  assert.ok(imageBuildWorkflow.includes('type=raw,value=${{ env.SOURCE_TAG }}'));
  assert.match(imageBuildWorkflow, /continue-on-error: true/);
  assert.match(imageBuildWorkflow, /steps\.build\.outcome == 'failure'/);
  assert.match(imageBuildWorkflow, /promote-images:[\s\S]*- build-and-push/);
  assert.equal(packageJson.scripts['verify:kubernetes:managed-live'], 'node scripts/kubernetes-managed-release-gate.mjs smoke');
  assert.equal(packageJson.scripts['verify:kubernetes:managed-disruption'], 'node scripts/kubernetes-managed-release-gate.mjs release');
  assert.match(imageBuildWorkflow, /gate_script=verify:kubernetes:managed-live/);
  assert.match(imageBuildWorkflow, /gate_script=verify:kubernetes:managed-disruption/);
  assert.match(imageBuildWorkflow, /npm run "\$gate_script"/);
  assert.doesNotMatch(imageBuildWorkflow, /verify:kubernetes:managed-\$mode/);
  assert.match(imageBuildWorkflow, /docker buildx imagetools create/);
  assert.match(imageBuildWorkflow, /for service in proxy web api executor/);
  assert.doesNotMatch(imageBuildPhase, /type=raw,value=latest/);
  assert.ok(imagePromotionPhase.includes("type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main-rivet2' }}"));
  assert.ok(imagePromotionPhase.includes('type=ref,event=branch'));

  for (const [service, dockerfile, platforms] of [
    ['proxy', 'image/proxy/Dockerfile', 'linux/amd64,linux/arm64'],
    ['web', 'image/web/Dockerfile', 'linux/amd64,linux/arm64'],
    ['api', 'image/api/Dockerfile', 'linux/amd64'],
    ['executor', 'image/executor/Dockerfile', 'linux/amd64'],
  ] as const) {
    assert.match(
      imageBuildWorkflow,
      new RegExp(
        `- service: ${service}\\s+dockerfile: ${dockerfile.replace(/\//g, '\\/')}\\s+image: ghcr\\.io\\/valerypopoff\\/cloud-hosted-rivet2-wrapper\\/${service}\\s+platforms: ${platforms.replace(/\//g, '\\/')}`,
      ),
    );
    assert.ok(prodCompose.includes(`ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/${service}`));
    assert.ok(envExample.includes(`ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/${service}:latest`));
  }

  assert.match(webDockerfile, /COPY --from=rivet_dependency_metadata \. rivet\//);
  assert.match(webDockerfile, /COPY --from=rivet_source \. \/app\/rivet\//);
  assert.match(webDockerfile, /YARN_NODE_LINKER=node-modules yarn build:hosted-web-deps/);
  assert.match(apiDockerfile, /COPY --from=rivet_dependency_metadata \. rivet\//);
  assert.match(apiDockerfile, /COPY --from=rivet_source \. \/app\/rivet\//);
  assert.match(apiDockerfile, /YARN_NODE_LINKER=node-modules yarn build:runtime/);
  assert.match(apiDockerfile, /YARN_NODE_LINKER=node-modules yarn build:hosted-web-deps/);
  assert.match(executorDockerfile, /COPY --from=rivet_dependency_metadata \. \/app\/rivet\//);
  assert.match(executorDockerfile, /COPY --from=rivet_source \. \/app\/rivet\//);
  assert.match(executorDockerfile, /YARN_NODE_LINKER=node-modules yarn build:runtime/);
  assert.match(executorDockerfile, /bundle-executor\.cjs/);
  assert.doesNotMatch(
    `${apiDockerfile}\n${webDockerfile}\n${executorDockerfile}`,
    /yarn workspace @valerypopoff\/(rivet2-core|rivet2-node|rivet2-evaluations) run build/,
  );
  assert.doesNotMatch(webPackageJson, /"rivet-studio-server":\s*"file:\.\.\/\.\."/);
  assert.doesNotMatch(webPackageLock, /"node_modules\/rivet-studio-server"/);
  assert.doesNotMatch(imageBuildWorkflow, legacyImageNamespacePattern);
  assert.doesNotMatch(prodCompose, legacyImageNamespacePattern);
  assert.doesNotMatch(envExample, legacyImageNamespacePattern);
  assert.doesNotMatch(bootstrapRivet, legacyRepoPattern);
  assert.doesNotMatch(ensureDevDeps, legacyRepoPattern);
  assert.match(bootstrapRivet, /RIVET_REPO_URL \|\| 'https:\/\/github\.com\/valerypopoff\/rivet2\.0\.git'/);
  assert.match(bootstrapRivet, /RIVET_REPO_REF \|\| process\.env\.RIVET_BRANCH \|\| 'main'/);
  assert.match(bootstrapRivet, /function isCommitSha\(value\)/);
  assert.match(bootstrapRivet, /refName\?\.endsWith\('\^\{\}'\)/);
  assert.match(bootstrapRivet, /'fetch', '--depth', '1', 'origin', commit/);

  assert.match(prodCompose, /proxy:[\s\S]*dockerfile: image\/proxy\/Dockerfile/);
  assert.match(prodCompose, /proxy:[\s\S]*"\$\{RIVET_PORT:-8080\}:8080"/);
  assert.match(prodCompose, /RIVET_PROXY_RESOLVER=\$\{RIVET_PROXY_RESOLVER:-127\.0\.0\.11\}/);
  assert.match(prodCompose, /RIVET_EXECUTION_UPSTREAM_HOST=api/);
  assert.match(prodCompose, /RIVET_EXECUTION_UPSTREAM_PORT=80/);
  assert.deepEqual(productionScripts, ['prod', 'prod:custom', 'prod:prebuilt', 'prod:restart']);
  assert.equal(packageJson.scripts.prod, 'npm run prod:prebuilt');
  assert.equal(packageJson.scripts['prod:prebuilt'], 'node scripts/prod-docker.mjs prebuilt');
  assert.equal(packageJson.scripts['prod:restart'], 'node scripts/prod-docker.mjs restart');
  assert.equal(packageJson.scripts['prod:custom'], 'node scripts/prod-docker.mjs custom');
  assert.match(prodDockerLauncher, /pull proxy web api executor/);
  assert.match(prodDockerLauncher, /--no-build --force-recreate --remove-orphans --wait/);
  assert.match(prodDockerLauncher, /--build --force-recreate --remove-orphans --wait/);
  assert.doesNotMatch(prodDockerLauncher, /auto|prod-prebuilt|recreate-prebuilt/);
  assert.match(proxyDockerfile, /ENV RIVET_EXECUTION_UPSTREAM_HOST=api/);
  assert.match(proxyDockerfile, /ENV RIVET_EXECUTION_UPSTREAM_PORT=8080/);
  assert.match(proxyDockerfile, /ENV RIVET_PROXY_RESOLVER=127\.0\.0\.11/);
});
