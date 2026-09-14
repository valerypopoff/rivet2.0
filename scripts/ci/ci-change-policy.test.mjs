import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyChangedPaths, listChangedPaths } from './ci-change-policy.mjs';

test('deleted and moved deployment files still require verification of their original location', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-ci-changes-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CI fixture');
    git('config', 'user.email', 'ci@example.invalid');
    const original = 'deploy/studio-server/kubernetes-test/fixture.yaml';
    fs.mkdirSync(path.dirname(path.join(directory, original)), { recursive: true });
    fs.writeFileSync(path.join(directory, original), 'fixture\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const base = git('rev-parse', 'HEAD');
    fs.renameSync(path.join(directory, original), path.join(directory, 'moved.yaml'));
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'move fixture');
    const moved = listChangedPaths(base, 'HEAD', directory);
    assert.ok(moved.includes(original));
    assert.ok(moved.includes('moved.yaml'));
    assert.equal(classifyChangedPaths(moved).fullKubernetes, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Yarn runtime changes reach all deliverables and Kubernetes fixture changes require the live gate', () => {
  const yarn = classifyChangedPaths(['.yarn/releases/yarn-4.17.1.cjs']);
  assert.equal(yarn.studioServer, true);
  assert.equal(yarn.desktop, true);
  assert.equal(yarn.npm, true);
  assert.equal(
    classifyChangedPaths(['deploy/studio-server/kubernetes-test/local-dependencies.yaml']).fullKubernetes,
    true,
  );
});

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
