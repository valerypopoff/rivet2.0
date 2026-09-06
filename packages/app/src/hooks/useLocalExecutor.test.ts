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
  assert.match(useLocalExecutorSource, /currentProcessorsByProjectId\.current\.get\(runProjectId\)\?\.isRunning/);
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
  assert.match(
    useLocalExecutorSource,
    /processor\.on\('llmProfileAttempt', \(data\) => \{[\s\S]*routeLocalProcessEvent\(runProjectId, 'llmProfileAttempt', data, \(\) => eventDispatcher\.llmProfileAttempt\(data\)\)/,
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
  assert.match(
    useLocalExecutorSource,
    /processor\.abort\(\);[\s\S]*currentProcessorsByProjectId\.current\.delete\(projectId\);/,
  );
  assert.match(useLocalExecutorSource, /editorExecutionCachesByProjectId\.current\.delete\(projectId\);/);
});

test('local executor forwards a host-provided LLM profile health store to every browser run', () => {
  assert.match(useLocalExecutorSource, /const llmProfileHealthStore = useLLMProfileHealthStore\(\)/);
  assert.equal(useLocalExecutorSource.match(/llmProfileHealthStore,/g)?.length, 2);
});

test('local recording playback revalidates its captured owner before and after the pre-start yield', () => {
  assert.match(useLocalExecutorSource, /isCurrentLoadedRecordingForTab/);
  assert.match(
    useLocalExecutorSource,
    /await yieldToMacrotask\(\);[\s\S]*store\.get\(loadedRecordingState\),[\s\S]*recordingToReplay,[\s\S]*runProjectId/,
  );
  assert.match(
    useLocalExecutorSource,
    /if \(recordingToReplay\) \{[\s\S]*isCurrentLoadedRecordingForTab\([\s\S]*setRecordingPlaybackStarting\(false\)/,
  );
});

test('local executor stops hidden browser snapshots when startup fails before a terminal event', () => {
  assert.match(
    useLocalExecutorSource,
    /function markInactiveLocalRunFailed\(runProjectId: ProjectId, error: unknown\)/,
  );
  assert.match(useLocalExecutorSource, /routeLocalProcessEvent\(\s*runProjectId,\s*'error',/);
  assert.match(useLocalExecutorSource, /markInactiveLocalRunFailed\(runProjectId, e\);/);
});

test('local executor stores hidden browser recordings in project execution snapshots', () => {
  assert.match(
    useLocalExecutorSource,
    /function setLastRecordingForProject\(runProjectId: ProjectId, recording: string\)/,
  );
  assert.match(useLocalExecutorSource, /lastRecording: recording/);
  assert.match(useProjectExecutionSnapshotsSource, /lastRecording: store\.get\(lastRecordingState\)/);
  assert.match(useProjectExecutionSnapshotsSource, /store\.set\(lastRecordingState, nextSnapshot\.lastRecording\)/);
});

test('local executor controls target the active project processor only', () => {
  assert.match(
    useLocalExecutorSource,
    /currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)\?\.abort\(\)/,
  );
  assert.match(
    useLocalExecutorSource,
    /currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)\?\.pause\(\)/,
  );
  assert.match(
    useLocalExecutorSource,
    /currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)\?\.resume\(\)/,
  );
  assert.match(
    useLocalExecutorSource,
    /const processor = currentProcessorsByProjectId\.current\.get\(project\.metadata\.id as ProjectId\)/,
  );
});

test('remote executor dispatch isolates Run Activity and primary UI projection failures', () => {
  assert.match(
    remoteExecutorHelpersSource,
    /const dispatchWithRunActivity[\s\S]*dispatchRunActivityEvent\(message, data\);[\s\S]*return dispatchGraphExecutionEvent\(message, dispatchPrimary\)/,
  );
  assert.match(
    remoteExecutorHelpersSource,
    /nodeFinish: \(data: unknown\) =>[\s\S]*dispatchWithRunActivity\('nodeFinish',[\s\S]*currentExecution\.onNodeFinish\(data as ProcessEvents\['nodeFinish'\]\)/,
  );
  assert.doesNotMatch(remoteExecutorHelpersSource, /nodeFinish: \(data: unknown\) => currentExecution\.onNodeFinish/);
});

test('both executors finalize through the shared lifecycle before applying the terminal snapshot', () => {
  for (const source of [
    useLocalExecutorSource,
    readFileSync(new URL('./useRemoteExecutor.ts', import.meta.url), 'utf8'),
  ]) {
    assert.match(source, /const finalizedRun = await executeEvaluationRunLifecycle\(/);
    assert.match(source, /applyEvaluationRunSnapshot\(state, finalizedRun\)/);
  }
});

test('hosted local recordings are linked only after an unhealthy LLM health update and terminal processor completion', () => {
  assert.match(useLocalExecutorSource, /useLocalExecutionRecordingPersistence\(\)/);
  assert.match(useLocalExecutorSource, /localExecutionRecordingPersistence\.getCapability\(\)\.catch\(\(\) => false\)/);
  assert.match(
    useLocalExecutorSource,
    /event\.stage === 'health-update' && event\.outcome === 'success' && event\.healthOutcome === 'unhealthy/,
  );
  assert.match(useLocalExecutorSource, /llmProfileHealthExecutionCorrelationId: localRecordingCorrelationId/);
  assert.match(useLocalExecutorSource, /!hasUnhealthyLLMProfileHealthEvidence\s*\|\|\s*!localRecordingProvider/);
  assert.match(useLocalExecutorSource, /projectContents: serializeProject\(tempProject\) as string/);
  assert.match(useLocalExecutorSource, /const completion = processor\?\.isRunning/);
  assert.match(useLocalExecutorSource, /then\(\(\) => finalizeCapturedRecording!\(\)\)/);
  assert.match(
    useLocalExecutorSource,
    /processor\.on\('abort', \(event\) => \{[\s\S]*localRecordingStatus = 'suspicious'/,
  );
  assert.match(useLocalExecutorSource, /localRecordingProvider\.markUnavailable\(localRecordingCorrelationId\)/);
});
