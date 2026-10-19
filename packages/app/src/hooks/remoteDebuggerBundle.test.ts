import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpenedProjectInfo } from '../state/savedGraphs.js';
import { getRemoteDebuggerBundleProjects } from './remoteDebuggerBundle.js';

const id = (value: string) => value as ProjectId;

test('ordinary folder proximity does not confer membership, and a standalone project includes itself', () => {
  const opened = Object.fromEntries(
    ['a', 'b', 'c'].map((name) => [name, { projectId: id(name), title: name, fsPath: `/same-folder/${name}` }]),
  );
  for (const name of ['a', 'b', 'c', 'not-opened'])
    assert.deepEqual(getRemoteDebuggerBundleProjects(id(name), opened), [name]);
});

test('explicit bundle manifests include disconnected members but not a different manifest', () => {
  const opened = Object.fromEntries(
    ['a', 'b', 'c'].map((name) => [
      name,
      {
        projectId: id(name),
        title: name,
        bundleManifestPath: name === 'c' ? '/other/rivet-bundle.json' : '/bundle/rivet-bundle.json',
      },
    ]),
  );
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('b'), opened), ['a', 'b']);
});

test('hosted membership is server-scoped and clearing membership isolates a former member', () => {
  const opened: Record<string, OpenedProjectInfo> = Object.fromEntries(
    ['a', 'b', 'c'].map((name) => [
      name,
      {
        projectId: id(name),
        title: name,
        hostedBundleKey: `${name === 'c' ? 'other' : 'server'}/bundle:one`,
      },
    ]),
  );
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('b'), opened), ['a', 'b']);
  opened.b!.hostedBundleKey = null;
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('b'), opened), ['b']);
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('a'), opened), ['a']);
});

test('authoritative hosted identity takes precedence over a portable manifest hint', () => {
  const opened: Record<string, OpenedProjectInfo> = Object.fromEntries(
    ['a', 'b'].map((name) => [
      name,
      {
        projectId: id(name),
        title: name,
        bundleManifestPath: '/same/rivet-bundle.json',
        hostedBundleKey: `server/bundle:${name}`,
      },
    ]),
  );
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('a'), opened), ['a']);
  opened.a!.hostedBundleKey = null;
  opened.b!.hostedBundleKey = null;
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('a'), opened), ['a']);
});

test('portable dependency snapshots retain their loader binding without joining debugger membership', () => {
  const opened = Object.fromEntries(
    ['a', 'b', 'dependency'].map((name) => [
      name,
      {
        projectId: id(name),
        title: name,
        bundleManifestPath: '/bundle/rivet-bundle.json',
        bundleMember: name !== 'dependency',
      },
    ]),
  );
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('a'), opened), ['a', 'b']);
  assert.deepEqual(getRemoteDebuggerBundleProjects(id('dependency'), opened), ['dependency']);
});
