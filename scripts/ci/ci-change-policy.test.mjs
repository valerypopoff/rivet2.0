import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths } from './ci-change-policy.mjs';

test('Studio Server application changes do not trigger desktop or npm releases', () => {
  assert.deepEqual(classifyChangedPaths(['packages/studio-server-api/src/server.ts']), {
    studioServer: true,
    studioImages: true,
    desktop: false,
    npm: false,
    fullKubernetes: false,
  });
});

test('shared runtime changes trigger every dependent deliverable', () => {
  assert.deepEqual(classifyChangedPaths(['packages/core/src/index.ts']), {
    studioServer: true,
    studioImages: true,
    desktop: true,
    npm: true,
    fullKubernetes: false,
  });
});

test('desktop application changes trigger its hosted and desktop consumers', () => {
  assert.deepEqual(classifyChangedPaths(['packages/app/src/App.tsx']), {
    studioServer: true,
    studioImages: true,
    desktop: true,
    npm: false,
    fullKubernetes: false,
  });
});

test('public documentation changes trigger only the desktop documentation release', () => {
  assert.deepEqual(classifyChangedPaths(['packages/docs/docs/intro.md']), {
    studioServer: false,
    studioImages: false,
    desktop: true,
    npm: false,
    fullKubernetes: false,
  });
});

test('deployment changes require the full Kubernetes gate', () => {
  const result = classifyChangedPaths(['deploy/studio-server/helm/rivet/values.yaml']);
  assert.equal(result.studioServer, true);
  assert.equal(result.studioImages, true);
  assert.equal(result.fullKubernetes, true);
  assert.equal(result.desktop, false);
});

test('proxy, image, and production Compose changes require the full Kubernetes gate', () => {
  for (const changedPath of [
    'deploy/studio-server/images/proxy/default.conf.template',
    'deploy/studio-server/compose/docker-compose.yml',
    'deploy/studio-server/scripts/prod-docker.mjs',
  ]) {
    const result = classifyChangedPaths([changedPath]);
    assert.equal(result.studioImages, true, `${changedPath} must rebuild candidate images.`);
    assert.equal(result.fullKubernetes, true, `${changedPath} must require full Kubernetes verification.`);
  }
});
test('publishable CLI changes trigger npm without rebuilding desktop or Studio Server images', () => {
  assert.deepEqual(classifyChangedPaths(['packages/cli/src/index.ts']), {
    studioServer: false,
    studioImages: false,
    desktop: false,
    npm: true,
    fullKubernetes: false,
  });
});

test('developer documentation does not launch release workflows', () => {
  assert.deepEqual(classifyChangedPaths(['developer-docs/BUILD-AND-CI.md']), {
    studioServer: false,
    studioImages: false,
    desktop: false,
    npm: false,
    fullKubernetes: false,
  });
});
