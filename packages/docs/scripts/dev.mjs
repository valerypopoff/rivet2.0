import { spawnWorkspaceScript, terminateWorkspaceProcess, waitForChild } from './workspace-command.mjs';

const promoUrl = 'http://localhost:5174/';
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

process.once('SIGINT', handleSignal);
process.once('SIGTERM', handleSignal);

const promoBuild = spawnWorkspaceScript('@valerypopoff/rivet-app', 'build:promo', {
  env: { RIVET_PROMO_BASE_URL: '/' },
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

const promoServer = spawnWorkspaceScript('@valerypopoff/rivet-app', 'preview:promo');
children.push(promoServer);

async function waitForPromoServer() {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (promoServer.exitCode != null || promoServer.signalCode != null) {
      throw new Error('The bundled Rivet promo preview exited before it became ready.');
    }

    try {
      const response = await fetch(promoUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Vite Preview is still starting.
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }

  throw new Error(`The bundled Rivet promo preview did not become ready at ${promoUrl}.`);
}

try {
  await waitForPromoServer();
} catch (error) {
  stopChildren();
  throw error;
}

children.push(
  spawnWorkspaceScript('docs', 'dev:site', {
    env: { RIVET_PROMO_DEMO_URL: promoUrl },
  }),
);

await new Promise((resolvePromise, reject) => {
  for (const child of children) {
    child.once('error', (error) => {
      stopChildren();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!stopping) {
        stopChildren();
        reject(
          new Error(
            `A docs development server exited with ${
              signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
            }. Both servers have been stopped.`,
          ),
        );
        return;
      }

      if (children.every((candidate) => candidate.exitCode != null || candidate.signalCode != null)) {
        resolvePromise();
      }
    });
  }
});
