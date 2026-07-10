import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GraphRunLifecycle } from '../../src/model/GraphRunLifecycle.js';

describe('GraphRunLifecycle', () => {
  it('resets abort and finish-once state for each reusable run', () => {
    const lifecycle = new GraphRunLifecycle();
    lifecycle.begin();
    assert.deepEqual(lifecycle.requestAbort(false, 'first failure'), {
      successful: false,
      error: 'first failure',
    });
    assert.equal(lifecycle.claimRootFinish(false), true);
    assert.equal(lifecycle.claimRootFinish(false), false);
    lifecycle.complete();

    lifecycle.begin();
    assert.equal(lifecycle.isAborted, false);
    assert.equal(lifecycle.abortError, undefined);
    assert.equal(lifecycle.claimRootFinish(false), true);
  });

  it('preserves pause across run boundaries and reports only real transitions', () => {
    const lifecycle = new GraphRunLifecycle();
    assert.equal(lifecycle.pause(), true);
    assert.equal(lifecycle.pause(), false);
    lifecycle.begin();
    assert.equal(lifecycle.isRunning, true);
    assert.equal(lifecycle.isPaused, true);
    lifecycle.complete();
    assert.equal(lifecycle.isRunning, false);
    assert.equal(lifecycle.isPaused, true);
    assert.equal(lifecycle.resume(), true);
    assert.equal(lifecycle.resume(), false);
  });

  it('accepts one abort only while a run is active', () => {
    const lifecycle = new GraphRunLifecycle();
    assert.equal(lifecycle.requestAbort(false), undefined);
    lifecycle.begin();
    assert.deepEqual(lifecycle.requestAbort(true), { successful: true, error: undefined });
    assert.equal(lifecycle.requestAbort(false, 'late failure'), undefined);
    assert.equal(lifecycle.abortSuccessful, true);
    lifecycle.complete();
    assert.equal(lifecycle.requestAbort(false), undefined);
  });

  it('never claims root finish for subprocessors', () => {
    const lifecycle = new GraphRunLifecycle();
    lifecycle.begin();
    assert.equal(lifecycle.claimRootFinish(true), false);
    assert.equal(lifecycle.claimRootFinish(false), true);
  });
});
