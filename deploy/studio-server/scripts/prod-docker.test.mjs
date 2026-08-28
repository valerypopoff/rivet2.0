import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PRODUCTION_COMPOSE_PROJECT,
  appDataVolumeName,
  resolveProductionComposeProject,
} from './prod-docker.mjs';

async function resolveWithVolumes(volumes, environment = {}) {
  return resolveProductionComposeProject({
    environment,
    volumeExists: async (volumeName) => volumes.has(volumeName),
  });
}

test('production launcher defaults to the standalone Compose identity for a fresh deployment', async () => {
  assert.deepEqual(await resolveWithVolumes(new Set()), {
    composeProject: DEFAULT_PRODUCTION_COMPOSE_PROJECT,
    source: 'default',
  });
});

test('production launcher adopts either known legacy app-data volume', async () => {
  assert.deepEqual(await resolveWithVolumes(new Set(['ops_rivet_data'])), {
    composeProject: 'ops',
    source: 'detected',
  });
  assert.deepEqual(await resolveWithVolumes(new Set(['compose_rivet_data'])), {
    composeProject: 'compose',
    source: 'detected',
  });
});

test('an explicit Compose-project choice wins over automatic legacy detection', async () => {
  assert.deepEqual(
    await resolveWithVolumes(new Set(['ops_rivet_data']), {
      RIVET_STUDIO_SERVER_COMPOSE_PROJECT: 'production-rivet',
    }),
    { composeProject: 'production-rivet', source: 'configured' },
  );
});

test('production launcher refuses ambiguous legacy app-data volumes', async () => {
  await assert.rejects(
    () => resolveWithVolumes(new Set(['ops_rivet_data', 'compose_rivet_data'])),
    /multiple legacy Studio Server app-data volumes/i,
  );
});

test('production launcher validates an explicit Compose-project name', async () => {
  await assert.rejects(
    () =>
      resolveWithVolumes(new Set(), {
        RIVET_STUDIO_SERVER_COMPOSE_PROJECT: 'Rivet Production',
      }),
    /must be a lowercase Docker Compose project name/i,
  );
  assert.equal(appDataVolumeName('ops'), 'ops_rivet_data');
});
