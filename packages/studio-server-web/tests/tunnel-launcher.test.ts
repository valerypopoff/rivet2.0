import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentFrontendEnv } from '../../../deploy/studio-server/scripts/lib/dev-env.mjs';

test('frontend mode selects bounded startup grace without changing live defaults', () => {
  assert.deepEqual(developmentFrontendEnv(), { RIVET_DEV_FRONTEND_MODE: 'live', RIVET_DEV_WEB_START_PERIOD: '180s' });
  assert.deepEqual(developmentFrontendEnv('tunnel'), {
    RIVET_DEV_FRONTEND_MODE: 'tunnel',
    RIVET_DEV_WEB_START_PERIOD: '900s',
  });
  assert.throws(() => developmentFrontendEnv('production'), /Frontend mode/);
});
