import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hooksDir = dirname(fileURLToPath(import.meta.url));

test('workspace host releases cached context atoms without deleting persisted context values', () => {
  const savedGraphsSource = readFileSync(join(hooksDir, '..', 'state', 'savedGraphs.ts'), 'utf8');
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');

  assert.match(savedGraphsSource, /export function releaseProjectContextState\(projectId: ProjectId\): void \{/);
  assert.match(savedGraphsSource, /projectContextState\.remove\(projectId\);/);
  assert.doesNotMatch(savedGraphsSource, /storage\.removeItem\(`projectContext__"\$\{projectId\}"`\)/);
  assert.match(workspaceHostSource, /releaseProjectContextState\(currentProjectId\);/);
  assert.match(workspaceHostSource, /releaseProjectContextState\(projectId\);/);
  assert.doesNotMatch(workspaceHostSource, /clearProjectContextState/);
});

test('workspace host exposes a narrow clean-baseline API for hosted wrappers', () => {
  const workspaceHostSource = readFileSync(join(hooksDir, 'useRivetWorkspaceHost.ts'), 'utf8');
  const hostSource = readFileSync(join(hooksDir, '..', 'host.tsx'), 'utf8');

  const cleanBaselineType = workspaceHostSource.match(
    /export type RivetProjectCleanBaselineSnapshotInput = \{(?<body>[\s\S]*?)\};/,
  )?.groups?.body;

  assert.ok(cleanBaselineType);
  assert.match(cleanBaselineType, /project: Project \| Omit<Project, 'data'>;/);
  assert.match(cleanBaselineType, /data\?: Project\['data'\];/);
  assert.doesNotMatch(cleanBaselineType, /path\?:/);
  assert.doesNotMatch(cleanBaselineType, /openedGraph\?:/);
  assert.doesNotMatch(cleanBaselineType, /testSuites\?:/);
  assert.match(
    workspaceHostSource,
    /markCurrentProjectClean\(snapshot\?: RivetProjectCleanBaselineSnapshotInput\): Promise<boolean>;/,
  );
  assert.match(
    workspaceHostSource,
    /markProjectClean\(projectId: ProjectId, snapshot\?: RivetProjectCleanBaselineSnapshotInput\): Promise<boolean>;/,
  );
  assert.match(workspaceHostSource, /buildCurrentProjectContentSnapshot\(/);
  assert.match(workspaceHostSource, /markProjectContentClean\(previousDigests, cleanBaseline\)/);
  assert.match(workspaceHostSource, /markProjectDirtyFlag\(previousFlags, projectId, false\)/);
  assert.match(workspaceHostSource, /if \(!projects\.openedProjects\[projectId\] && currentProject\.metadata\.id !== projectId\) \{/);
  assert.match(hostSource, /RivetProjectCleanBaselineSnapshotInput/);
});
