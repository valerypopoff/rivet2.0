import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const useLocalExecutorSource = readFileSync(new URL('./useLocalExecutor.ts', import.meta.url), 'utf8');
const useProjectExecutionSnapshotsSource = readFileSync(
  new URL('./useProjectExecutionSnapshots.ts', import.meta.url),
  'utf8',
);
const remoteExecutorHelpersSource = readFileSync(new URL('./remoteExecutorHelpers.ts', import.meta.url), 'utf8');

test('local executor owns browser processors per project and clears the settled owner', () => {
  assert.match(
    useLocalExecutorSource,
    /currentProcessorsByProjectId = useRef\(new Map<ProjectId, GraphProcessor>\(\)\)/,
  );
  assert.match(
    useLocalExecutorSource,
    /currentProcessorsByProjectId\.current\.get\(runProjectId\)\?\.isRunning/,
  );
  assert.match(
    useLocalExecutorSource,
    /finally\s*\{[\s\S]*if \(processor && runProjectId && store\.get\(projectState\)\.metadata\.id === runProjectId\) \{[\s\S]*dispatchGraphExecutionEvent\('stop', \(\) => currentExecution\.onStop\(\)\);[\s\S]*currentProcessorsByProjectId\.current\.delete\(runProjectId\);/,
  );
});

test('local executor isolates awaited processor event handlers from UI projection failures', () => {
  assert.match(
    useLocalExecutorSource,
    /routeLocalProcessEvent\(runProjectId, 'nodeFinish', data, \(\) => eventDispatcher\.nodeFinish\(data\)\)/,
  );
  assert.doesNotMatch(useLocalExecutorSource, /processor\.on\('nodeFinish', currentExecution\.onNodeFinish\)/);
});

test('local executor routes inactive project browser events into execution snapshots', () => {
  assert.match(useLocalExecutorSource, /applyProcessEventToProjectExecutionSnapshots/);
  assert.match(useLocalExecutorSource, /shouldRouteProjectEventToSnapshot/);
  assert.match(useLocalExecutorSource, /projectExecutionSnapshotsState/);
  assert.match(useLocalExecutorSource, /if \(activeProjectId === runProjectId\) \{/);
  assert.match(useLocalExecutorSource, /openedProjectsState\[runProjectId\]/);
});

test('local executor clears project-owned browser runtime resources on project close', () => {
  assert.match(useLocalExecutorSource, /processor\.abort\(\);[\s\S]*currentProcessorsByProjectId\.current\.delete\(projectId\);/);
  assert.match(useLocalExecutorSource, /editorExecutionCachesByProjectId\.current\.delete\(projectId\);/);
});

test('local executor stops hidden browser snapshots when startup fails before a terminal event', () => {
  assert.match(useLocalExecutorSource, /function markInactiveLocalRunFailed\(runProjectId: ProjectId, error: unknown\)/);
  assert.match(useLocalExecutorSource, /routeLocalProcessEvent\(\s*runProjectId,\s*'error',/);
  assert.match(useLocalExecutorSource, /markInactiveLocalRunFailed\(runProjectId, e\);/);
});

test('local executor stores hidden browser recordings in project execution snapshots', () => {
  assert.match(useLocalExecutorSource, /function setLastRecordingForProject\(runProjectId: ProjectId, recording: string\)/);
  assert.match(useLocalExecutorSource, /lastRecording: recording/);
  assert.match(useProjectExecutionSnapshotsSource, /lastRecording: store\.get\(lastRecordingState\)/);
  assert.match(useProjectExecutionSnapshotsSource, /store\.set\(lastRecordingState, nextSnapshot\.lastRecording\)/);
});

test('local executor controls target the active project processor only', () => {
  assert.match(useLocalExecutorSource, /currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)\?\.abort\(\)/);
  assert.match(useLocalExecutorSource, /currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)\?\.pause\(\)/);
  assert.match(useLocalExecutorSource, /currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)\?\.resume\(\)/);
  assert.match(
    useLocalExecutorSource,
    /const processor = currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)/,
  );
});

test('remote executor dispatch also isolates UI projection failures', () => {
  assert.match(
    remoteExecutorHelpersSource,
    /dispatchGraphExecutionEvent\('nodeFinish', \(\) =>[\s\S]*currentExecution\.onNodeFinish\(data as ProcessEvents\['nodeFinish'\]\)/,
  );
  assert.doesNotMatch(remoteExecutorHelpersSource, /nodeFinish: \(data: unknown\) => currentExecution\.onNodeFinish/);
});
