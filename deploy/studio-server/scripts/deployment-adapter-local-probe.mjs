import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

// Reviewed import checks must not acquire a production connection as a module
// side effect. This guard is a tripwire, not a sandbox for untrusted code.
const denied = () => {
  throw Error('Networking is forbidden in the local deployment prerequisite probe.');
};
net.connect = net.createConnection = tls.connect = denied;
net.Socket.prototype.connect = denied;
http.get = http.request = https.get = https.request = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--configuration')
    throw Error('Expected a reviewed local probe configuration.');
  const config = JSON.parse(await fs.readFile(process.argv[3], 'utf8'));
  if (config.platform !== process.platform || process.platform !== 'win32')
    throw Error('This installation uses Windows DPAPI; run readiness as its actual Windows operator.');
  const root = config.operatorRoot;
  process.env.ESBUILD_BINARY_PATH = config.esbuildBinary;
  const execute = promisify(execFile);
  const git = (args) =>
    execute('git', args, { cwd: config.schemaCheckoutRoot, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  if (
    (await git(['rev-parse', 'HEAD'])).stdout.trim() !== config.installedSource ||
    (await git(['status', '--porcelain', '--untracked-files=no'])).stdout.trim()
  )
    throw Error('Installed-schema helper checkout must remain clean at its exact recorded source.');
  const requireApi = createRequire(path.join(root, 'packages/studio-server-api/package.json'));
  const requireWeb = createRequire(path.join(root, 'packages/studio-server-web/package.json'));
  requireApi('pg');
  const esbuild = requireApi('esbuild');
  // Run the actual native service, not merely require its JavaScript wrapper.
  const transformed = await esbuild.transform('const answer: number = 42;', { loader: 'ts' });
  if (!transformed.code.includes('42')) throw Error('Native esbuild transform did not work.');
  const { tsImport } = await import(pathToFileURL(requireApi.resolve('tsx/esm/api')).href);
  for (const file of config.schemaModules) await tsImport(pathToFileURL(file).href, import.meta.url);
  const scopeModule = await import(pathToFileURL(config.scopeModule).href);
  const scope = scopeModule.buildScope(config.installedSource);
  if (!scope.tables?.length || scope.sourceSha !== config.installedSource)
    throw Error('Installed-source SQL scope is unverified.');
  for (const file of config.importModules) await import(pathToFileURL(file).href);
  const env = {
    ...process.env,
    YARN_ENABLE_NETWORK: '0',
    RIVET_LOCAL_DEPLOYMENT_PREFLIGHT: '1',
    PLAYWRIGHT_HEADLESS: '1',
    PLAYWRIGHT_SLOW_MO: '0',
    CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true',
  };
  await execute('powershell.exe', ['-NoProfile', '-File', config.keyProtectionProbe, '-GcloudPath', config.gcloud], {
    cwd: root,
    env,
    windowsHide: true,
    maxBuffer: 65536,
  });
  const { stdout: listing } = await execute(
    process.execPath,
    [
      path.join(root, '.yarn/releases/yarn-4.17.1.cjs'),
      'studio-server:ui:observe',
      '--config',
      config.playwrightConfig,
      '--list',
    ],
    { cwd: root, env, windowsHide: true, maxBuffer: 65536 },
  );
  if (!listing.includes(config.acceptanceTestTitle))
    throw Error('The real UI runner did not discover the reviewed acceptance test.');
  const { chromium } = requireWeb('@playwright/test');
  const browser = await chromium.launch({
    headless: true,
    executablePath: config.chromium,
    args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    timeout: 10000,
  });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent('<main>Local deployment readiness</main>');
    if ((await page.locator('main').innerText()) !== 'Local deployment readiness')
      throw Error('Local browser check failed.');
  } finally {
    await browser.close();
  }
  console.log(
    JSON.stringify({
      localOnly: true,
      imports: true,
      esbuild: true,
      browser: true,
      uiRunner: true,
      keyProtection: true,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
