import assert from 'node:assert/strict';
import test from 'node:test';
import { getHaControlPlaneMode, getScheduledRunScope, ownsMaintenance } from '../ha-control-plane.js';

test('singleton developer HA preserves a full editor while owning maintenance locally', () => {
  const env = {
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_HA_DEPLOYMENT: '1',
    RIVET_HA_CONTROL_PLANE_MODE: 'singleton',
    RIVET_HA_MAINTENANCE: '0',
  };
  assert.equal(getHaControlPlaneMode(env), 'singleton');
  assert.equal(ownsMaintenance(env), true);
  assert.equal(ownsMaintenance({ ...env, RIVET_HA_CONTROL_PLANE_MODE: 'replicated' }), false);
  assert.equal(ownsMaintenance({ ...env, RIVET_HA_MAINTENANCE: '1' }), true);
  assert.equal(ownsMaintenance({}), true);
  assert.throws(() => getHaControlPlaneMode({ RIVET_HA_CONTROL_PLANE_MODE: 'unknown' }));
  assert.throws(() => getHaControlPlaneMode({ RIVET_HA_CONTROL_PLANE_MODE: 'singleton' }));
});

test('published schedules move to execution; latest stays on developers; old/local roles stay compatible', () => {
  for (const mode of ['replicated', 'singleton']) {
    const env = { RIVET_HA_CONTROL_PLANE_MODE: mode, RIVET_DEPLOYMENT_TOPOLOGY: 'replicated' };
    assert.equal(getScheduledRunScope('execution', env), 'published');
    assert.equal(getScheduledRunScope('control', env), 'latest');
    assert.equal(getScheduledRunScope('evaluation', env), undefined);
    assert.equal(getScheduledRunScope('control', { ...env, RIVET_HA_MAINTENANCE: '1' }), undefined);
  }
  assert.equal(getScheduledRunScope('combined', {}), 'all');
  assert.equal(getScheduledRunScope('control', {}), 'all');
  assert.equal(getScheduledRunScope('execution', {}), undefined);
});
