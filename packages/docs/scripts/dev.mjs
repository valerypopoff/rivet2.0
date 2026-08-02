import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWorkspaceScript, terminateWorkspaceProcess, waitForChild } from './workspace-command.mjs';

const docsPort = 3000;
const loopbackHosts = ['127.0.0.1', '::1'];
const promoOutDir = '../../docs/.promo-dev/rivet-demo';
const docsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const promoStaticDirectory = resolve(docsDirectory, '.promo-dev');
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
    NODE_ENV: 'development',
    RIVET_PROMO_DEMO_URL: '',
  },
});
children.push(docsServer);

await monitorServer(docsServer, 'The Docusaurus development server');
