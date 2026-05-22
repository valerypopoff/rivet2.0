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
  assert.match(
    proxyLocation(imageProxyTemplate, /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/\s*\{/),
    /proxy_pass \$execution_upstream;/,
  );
  assert.match(
    proxyLocation(imageProxyTemplate, /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/\s*\{/),
    /proxy_pass \$api_upstream;/,
  );

  const latestDebuggerLocation = proxyLocation(imageProxyTemplate, /location \/ws\/latest-debugger\s*\{/);
  assert.match(imageProxyTemplate, /set \$api_latest_debugger_upstream http:\/\/\$\{RIVET_API_UPSTREAM_HOST\}:\$\{RIVET_API_UPSTREAM_PORT\}\/ws\/latest-debugger;/);
  assert.match(latestDebuggerLocation, /proxy_pass \$api_latest_debugger_upstream;/);
  assert.match(latestDebuggerLocation, /proxy_set_header X-Rivet-Proxy-Auth \$\{RIVET_PROXY_AUTH_TOKEN\};/);
  assert.match(latestDebuggerLocation, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(latestDebuggerLocation, /proxy_set_header Connection \$connection_upgrade;/);

  assert.ok(!imageProxyTemplate.includes('location /internal/workflows'));
  assert.match(proxyBootstrap, /resolve_proxy_resolver\(\)/);
  assert.match(proxyBootstrap, /export RIVET_PROXY_RESOLVER="\$\(resolve_proxy_resolver "\$\{RIVET_PROXY_RESOLVER:-\}"\)"/);
});

test('proxy UI gate prompt is served from container-local staged storage', () => {
  const proxyBootstrap = readRepoFile('image/proxy/normalize-workflow-paths.sh');
  const proxyDockerfile = readRepoFile('image/proxy/Dockerfile');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');

  for (const template of readProxyTemplates()) {
    const promptLocation = proxyLocation(template, /location @web_with_ui_gate_prompt\s*\{/);
    assert.match(promptLocation, /root \/tmp\/nginx\/html;/);
    assert.match(promptLocation, /try_files \/ui-gate-prompt\.html =500;/);
    assert.doesNotMatch(promptLocation, /root \/usr\/share\/nginx\/html;/);
  }

  assert.match(proxyBootstrap, /stage_ui_gate_prompt\(\) \{/);
  assert.match(proxyBootstrap, /destination_dir="\/tmp\/nginx\/html"/);
  assert.match(proxyBootstrap, /for candidate in \/tmp\/ui-gate-prompt\.html \/usr\/share\/nginx\/html\/ui-gate-prompt\.html; do/);
  assert.match(proxyDockerfile, /COPY --chown=10001:10001 image\/proxy\/ui-gate-prompt\.html \/usr\/share\/nginx\/html\/ui-gate-prompt\.html/);
  assert.match(devCompose, /image\/proxy\/ui-gate-prompt\.html:\/tmp\/ui-gate-prompt\.html:ro/);
  assert.doesNotMatch(devCompose, /ui-gate-prompt\.html:\/usr\/share\/nginx\/html\/ui-gate-prompt\.html:ro/);
  assert.doesNotMatch(prodCompose, /image\/proxy\/ui-gate-prompt\.html:/);
});

test('proxy templates keep HTTP workflow routes bounded and websocket routes long-lived', () => {
  const proxyDockerfile = readRepoFile('image/proxy/Dockerfile');

  for (const template of readProxyTemplates()) {
    for (const locationPattern of [
      /location \/api\/\s*\{/,
      /location \$\{RIVET_PUBLISHED_WORKFLOWS_BASE_PATH\}\/\s*\{/,
      /location \$\{RIVET_LATEST_WORKFLOWS_BASE_PATH\}\/\s*\{/,
    ]) {
      const location = proxyLocation(template, locationPattern);
      assert.match(location, /proxy_read_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
      assert.match(location, /proxy_send_timeout \$\{RIVET_PROXY_READ_TIMEOUT\};/);
    }

    assert.match(proxyLocation(template, /location \/ws\/latest-debugger\s*\{/), /proxy_read_timeout 86400s;/);
    assert.match(proxyLocation(template, /location \/ws\/executor\/internal\s*\{/), /proxy_read_timeout 86400s;/);
  }

  assert.match(proxyDockerfile, /ENV RIVET_PROXY_READ_TIMEOUT=180s/);
});

test('executor image and compose contracts keep the websocket service independent from API PORT', () => {
  const executorEntrypoint = readRepoFile('image/executor/entrypoint.sh');
  const executorDockerfile = readRepoFile('image/executor/Dockerfile');
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
  assert.doesNotMatch(executorDockerfile, /ENV PORT=21889/);
  assert.match(composeExecutorDockerfile, /ENV RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
  assert.ok(composeExecutorDockerfile.includes('node executor-bundle.cjs --host \\"${RIVET_EXECUTOR_HOST}\\" --port 21889'));

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /executor:[\s\S]*- PORT=21889[\s\S]*- RIVET_EXECUTOR_PORT=21889[\s\S]*- RIVET_EXECUTOR_HOST=0\.0\.0\.0/);
    assert.match(compose, /- HOME=\/home\/rivet/);
    assert.match(compose, /- npm_config_cache=\/home\/rivet\/\.npm/);
    assert.match(compose, /- YARN_CACHE_FOLDER=\/home\/rivet\/\.cache\/yarn/);
    assert.match(compose, /\/home\/rivet\/\.local\/share\/com\.valerypopoff\.rivet2/);
    assert.doesNotMatch(compose, /\/root\/\.npm|\/root\/\.cache\/yarn|HOME=\/root|\/root\/\.local\/share\/com\.valerypopoff\.rivet2/);
  }
});

test('API images and launchers use the filtered Rivet source context and symlink-preserved runtime links', () => {
  const apiDockerfile = readRepoFile('image/api/Dockerfile');
  const apiEntrypoint = readRepoFile('image/api/entrypoint.sh');
  const composeApiDockerfile = readRepoFile('ops/docker/Dockerfile.api');
  const prodCompose = readRepoFile('ops/compose/docker-compose.yml');
  const devCompose = readRepoFile('ops/compose/docker-compose.dev.yml');
  const devDockerLauncher = readRepoFile('scripts/dev-docker.mjs');
  const prodDockerLauncher = readRepoFile('scripts/prod-docker.mjs');
  const rivetContextHelper = readRepoFile('scripts/lib/rivet-source-context.mjs');
  const linkScript = readRepoFile('scripts/link-rivet-node-package.mjs');
  const ensureDevDeps = readRepoFile('scripts/ensure-dev-deps.mjs');
  const apiPackageJson = readRepoFile('wrapper/api/package.json');
  const apiTsconfig = readRepoFile('wrapper/api/tsconfig.json');
  const preserveSymlinksRunner = readRepoFile('scripts/run-preserve-symlinks.mjs');

  for (const dockerfile of [apiDockerfile, composeApiDockerfile]) {
    assert.match(dockerfile, /COPY --from=rivet_source \. rivet\//);
    assert.match(dockerfile, /yarn workspace @valerypopoff\/rivet2-core run build/);
    assert.match(dockerfile, /yarn workspace @valerypopoff\/rivet2-node run build/);
    assert.match(dockerfile, /RUN node \/app\/scripts\/link-rivet-node-package\.mjs/);
  }

  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/node_modules \/app\/rivet\/node_modules/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/core \/app\/rivet\/packages\/core/);
  assert.match(apiDockerfile, /COPY --from=builder --chown=10001:10001 \/app\/rivet\/packages\/node \/app\/rivet\/packages\/node/);
  assert.match(linkScript, /function ensureRivetNodeModulesReady\(\)/);
  assert.match(linkScript, /function removeRetiredPackageAliases\(\)/);
  assert.match(linkScript, /\.rivet-package-links/);
  assert.match(linkScript, /linkDirectory\(rivetNodeModulesDir, path\.join\(packageLinkDir, 'node_modules'\)\)/);
  assert.match(ensureDevDeps, /hasExpectedApiRivetLink\('rivet-core', 'rivet\/packages\/core', \[/);
  assert.match(ensureDevDeps, /hasExpectedApiRivetLink\('rivet-node', 'rivet\/packages\/node', \[/);
  assert.match(ensureDevDeps, /YARN_NODE_LINKER: 'node-modules'/);
  assert.match(ensureDevDeps, /isLinkedTo\(path\.join\(overlayRelPath, 'node_modules'\), 'rivet\/node_modules'\)/);

  assert.match(apiTsconfig, /"preserveSymlinks": true/);
  assert.match(apiPackageJson, /run-preserve-symlinks\.mjs tsx/);
  assert.match(apiPackageJson, /node --preserve-symlinks dist\/api\/src\/server\.js/);
  assert.match(preserveSymlinksRunner, /--preserve-symlinks/);
  assert.match(apiEntrypoint, /exec node --preserve-symlinks \/app\/wrapper\/api\/dist\/api\/src\/server\.js/);
  assert.match(composeApiDockerfile, /node --preserve-symlinks dist\/api\/src\/server\.js/);

  for (const compose of [prodCompose, devCompose]) {
    assert.match(compose, /additional_contexts:\s*\n\s*rivet_source: \$\{RIVET_SOURCE_BUILD_CONTEXT_PATH:-\.\.\/\.\.\/rivet\}/);
  }
  assert.match(devCompose, /api:[\s\S]*- rivet_node_modules:\/workspace\/rivet\/node_modules/);
  assert.match(devCompose, /RIVET_SOURCE_ROOT=\/app\/\.rivet-source RIVET_API_PACKAGE_ROOT=\/app node \/workspace\/scripts\/link-rivet-node-package\.mjs/);
  assert.match(devCompose, /api:[\s\S]*healthcheck:[\s\S]*start_period: 360s/);
  assert.match(devDockerLauncher, /prepareRivetDockerContext\(rootDir, mergedEnv\)/);
  assert.match(prodDockerLauncher, /prepareRivetDockerContext\(rootDir, mergedEnv\)/);
  assert.ok(rivetContextHelper.includes("const defaultContextRelPath = path.join(contextRootRelPath, 'rivet-source');"));
  assert.match(rivetContextHelper, /Excluded dependency folders, build output, VCS data, and Yarn cache artifacts/);
});

test('CI and production launchers publish and run the Rivet 2 wrapper image set', () => {
  const imageBuildWorkflow = readRepoFile('.github/workflows/build-images.yml');
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
  const legacyRepoPattern = new RegExp('Iron' + 'clad\\/rivet');
  const legacyImageNamespacePattern = new RegExp('cloud-hosted-' + 'rivet-wrapper');

  assert.match(imageBuildWorkflow, /branches:\s*\n\s*- main-rivet2/);
  assert.ok(imageBuildWorkflow.includes('RIVET_REPO_URL: https://github.com/valerypopoff/rivet2.0.git'));
  assert.ok(imageBuildWorkflow.includes('RIVET_REPO_REF: main'));
  assert.match(imageBuildWorkflow, /uses: docker\/setup-qemu-action@v3/);
  assert.match(imageBuildWorkflow, /uses: docker\/setup-buildx-action@v3/);
  assert.match(imageBuildWorkflow, /uses: docker\/login-action@v3/);
  assert.match(imageBuildWorkflow, /uses: docker\/metadata-action@v5/);
  assert.match(imageBuildWorkflow, /uses: docker\/build-push-action@v6/);
  assert.match(imageBuildWorkflow, /build-contexts:\s*\|\s*\n\s*rivet_source=\.\/rivet/);
  assert.match(imageBuildWorkflow, /push: true/);
  assert.ok(imageBuildWorkflow.includes("type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main-rivet2' }}"));
  assert.ok(imageBuildWorkflow.includes('type=ref,event=branch'));

  for (const [service, dockerfile, platforms] of [
    ['proxy', 'image/proxy/Dockerfile', 'linux/amd64,linux/arm64'],
    ['web', 'image/web/Dockerfile', 'linux/amd64,linux/arm64'],
    ['api', 'image/api/Dockerfile', 'linux/amd64,linux/arm64'],
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

  assert.match(webDockerfile, /COPY --from=rivet_source \. rivet\//);
  assert.match(apiDockerfile, /COPY --from=rivet_source \. rivet\//);
  assert.match(executorDockerfile, /COPY --from=rivet_source \. \/app\/rivet\//);
  assert.doesNotMatch(webPackageJson, /"rivet-studio-server":\s*"file:\.\.\/\.\."/);
  assert.doesNotMatch(webPackageLock, /"node_modules\/rivet-studio-server"/);
  assert.doesNotMatch(imageBuildWorkflow, legacyImageNamespacePattern);
  assert.doesNotMatch(prodCompose, legacyImageNamespacePattern);
  assert.doesNotMatch(envExample, legacyImageNamespacePattern);
  assert.doesNotMatch(bootstrapRivet, legacyRepoPattern);
  assert.doesNotMatch(ensureDevDeps, legacyRepoPattern);
  assert.match(bootstrapRivet, /RIVET_REPO_URL \|\| 'https:\/\/github\.com\/valerypopoff\/rivet2\.0\.git'/);
  assert.match(bootstrapRivet, /RIVET_REPO_REF \|\| process\.env\.RIVET_BRANCH \|\| 'main'/);

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
