import { createServer } from 'node:net';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWorkspaceScript, terminateWorkspaceProcess, waitForChild } from './workspace-command.mjs';

const docsPort = 3000;
const loopbackHosts = ['127.0.0.1', '::1'];
const promoOutDir = '../../docs/.promo-dev/rivet-demo';
const docsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const promoStaticDirectory = resolve(docsDirectory, '.promo-dev');
const developmentSearchBuildDirectory = resolve(docsDirectory, '.search-dev');
const require = createRequire(import.meta.url);
const { baseUrl } = require('../docusaurus.config.js');
const promoBaseUrl = `${baseUrl.replace(/\/?$/, '/')}rivet-demo/`;
const children = [];

let stopping = false;

function stopChildren() {
  if (stopping) {
    return;
  }

  stopping = true;
  for (const child of children) {
    terminateWorkspaceProcess(child);
  }
}

function handleSignal() {
  stopChildren();
}

function assertEndpointAvailable(host, port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => {
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') {
        resolvePromise();
        return;
      }

      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Documentation development port ${port} is already in use on ${host}. Stop the existing docs server before running yarn docs dev.`,
          ),
        );
        return;
      }

      reject(error);
    });
    server.listen({ exclusive: true, host, port }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePromise();
      });
    });
  });
}

function monitorServer(child, label) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', (error) => {
      stopChildren();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (stopping) {
        resolvePromise();
        return;
      }

      stopChildren();
      reject(
        new Error(
          `${label} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}. The docs development server has been stopped.`,
        ),
      );
    });
  });
}

process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);

for (const host of loopbackHosts) {
  await assertEndpointAvailable(host, docsPort);
}

if (dirname(promoStaticDirectory) !== docsDirectory || basename(promoStaticDirectory) !== '.promo-dev') {
  throw new Error(`Refusing to clean unexpected promo development directory: ${promoStaticDirectory}`);
}
await rm(promoStaticDirectory, { force: true, recursive: true });

if (
  dirname(developmentSearchBuildDirectory) !== docsDirectory ||
  basename(developmentSearchBuildDirectory) !== '.search-dev'
) {
  throw new Error(`Refusing to clean unexpected development search directory: ${developmentSearchBuildDirectory}`);
}
await rm(developmentSearchBuildDirectory, { force: true, recursive: true });

const developmentSearchBuild = spawnWorkspaceScript('docs', 'build:dev-search-index', {
  env: {
    NODE_ENV: 'production',
    RIVET_DOCS_DEV_SEARCH_INDEX: '1',
  },
});
children.push(developmentSearchBuild);

try {
  await waitForChild(developmentSearchBuild, 'The documentation development search-index build');
} catch (error) {
  stopChildren();
  throw error;
} finally {
  const buildIndex = children.indexOf(developmentSearchBuild);
  if (buildIndex >= 0) {
    children.splice(buildIndex, 1);
  }
}

const developmentSearchIndexes = (await readdir(developmentSearchBuildDirectory)).filter(
  (filename) => filename === 'search-index.json',
);
if (developmentSearchIndexes.length !== 1) {
  throw new Error(
    `Expected exactly one development search index in ${developmentSearchBuildDirectory}, found ${developmentSearchIndexes.length}.`,
  );
}
await mkdir(promoStaticDirectory, { recursive: true });
await cp(
  resolve(developmentSearchBuildDirectory, developmentSearchIndexes[0]),
  resolve(promoStaticDirectory, developmentSearchIndexes[0]),
);

const promoBuild = spawnWorkspaceScript('@valerypopoff/rivet-app', 'build:promo', {
  env: {
    RIVET_PROMO_BASE_URL: promoBaseUrl,
    RIVET_PROMO_OUT_DIR: promoOutDir,
  },
});
children.push(promoBuild);

try {
  await waitForChild(promoBuild, 'The Rivet promo development build');
} catch (error) {
  stopChildren();
  throw error;
} finally {
  const buildIndex = children.indexOf(promoBuild);
  if (buildIndex >= 0) {
    children.splice(buildIndex, 1);
  }
}

const docsServer = spawnWorkspaceScript('docs', 'dev:site', {
  env: {
    // The search plug-in intentionally does no browser-side work in a
    // development bundle. Docusaurus Start still provides live reload here;
    // the dedicated flag keeps development-only static files available.
    NODE_ENV: 'production',
    RIVET_PROMO_DEMO_URL: '',
    RIVET_DOCS_DEV_SEARCH_INDEX: '1',
  },
});
children.push(docsServer);

await monitorServer(docsServer, 'The Docusaurus development server');
