import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(join(srcDir, '..', path), 'utf8');
}

test('Project settings owns the compare-to-project entry point', () => {
  const projectInfoModalSource = source('components/ProjectInfoModal.tsx');
  const projectComparisonStateSource = source('state/projectComparison.ts');

  assert.match(projectInfoModalSource, /Compare to an older version/);
  assert.match(projectInfoModalSource, /ioProvider\.loadProjectData/);
  assert.match(projectInfoModalSource, /projectCompareReferenceState/);
  assert.match(projectComparisonStateSource, /graphState/);
  assert.match(projectComparisonStateSource, /\[graphId\]: graph/);
  assert.match(projectComparisonStateSource, /export type ProjectCompareSideLabels/);
  assert.match(projectComparisonStateSource, /referenceLabel: 'Previous'/);
  assert.match(projectComparisonStateSource, /currentLabel: 'Current'/);
  assert.match(projectComparisonStateSource, /resolveProjectCompareSideLabels/);
});

test('canvas compare mode highlights nodes and wires without changing graph data', () => {
  const nodeCanvasSource = source('components/NodeCanvas.tsx');
  const viewportSource = source('components/nodeCanvas/NodeCanvasViewport.tsx');
  const wireLayerSource = source('components/WireLayer.tsx');
  const nodeStylesSource = source('components/nodeStyles.ts');
  const normalVisualNodeContentSource = source('components/visualNode/NormalVisualNodeContent.tsx');
  const projectComparisonNodeChangesModalSource = source('components/ProjectComparisonNodeChangesModal.tsx');
  const projectComparisonCanvasSource = source('components/nodeCanvas/projectComparisonCanvas.ts');
  const graphBuilderSource = source('components/GraphBuilder.tsx');

  assert.match(graphBuilderSource, /resolveProjectCompareSideLabels/);
  assert.match(graphBuilderSource, /Compare mode: {activeComparisonLabels\.currentLabel} against/);
  assert.match(graphBuilderSource, /Current opened graph difference/);
  assert.match(graphBuilderSource, /getOverallProjectComparisonCounts/);
  assert.match(graphBuilderSource, /getGraphProjectComparisonCounts/);
  assert.match(nodeCanvasSource, /selectedGraphProjectComparisonState/);
  assert.match(nodeCanvasSource, /getCanvasNodeCompareKindsById/);
  assert.match(nodeCanvasSource, /compareRemovedNodes/);
  assert.match(nodeCanvasSource, /connectionCompareKindsByKey/);
  assert.match(projectComparisonCanvasSource, /graphComparison\.nodes/);
  assert.match(projectComparisonCanvasSource, /comparison\.kind === 'added'/);
  assert.match(projectComparisonCanvasSource, /comparison\.kind === 'changed'/);
  assert.match(viewportSource, /compareChangeKind="removed"/);
  assert.match(wireLayerSource, /\.wire\.compare-added/);
  assert.match(wireLayerSource, /\.wire\.compare-changed/);
  assert.match(wireLayerSource, /\.wire\.compare-removed/);
  assert.match(nodeStylesSource, /\.node\.compare-added/);
  assert.match(nodeStylesSource, /\.node\.compare-changed/);
  assert.match(nodeStylesSource, /0 0 0 2px var\(--success\)/);
  assert.match(nodeStylesSource, /0 0 0 2px var\(--warning-light\)/);
  assert.match(nodeStylesSource, /inset: -12px/);
  assert.match(nodeStylesSource, /border-width: 4px/);
  assert.match(nodeStylesSource, /\.node\.compare-removed/);
  assert.match(normalVisualNodeContentSource, /viewingProjectComparisonNodeState/);
  assert.match(normalVisualNodeContentSource, /View project comparison changes/);
  assert.match(projectComparisonNodeChangesModalSource, /getProjectNodeFieldComparisons/);
  assert.match(projectComparisonNodeChangesModalSource, /resolveProjectCompareSideLabels/);
  assert.match(projectComparisonNodeChangesModalSource, /labels\.referenceLabel/);
  assert.match(projectComparisonNodeChangesModalSource, /labels\.currentLabel/);
  assert.doesNotMatch(projectComparisonNodeChangesModalSource, />Previous</);
  assert.doesNotMatch(projectComparisonNodeChangesModalSource, />Current</);
  assert.match(projectComparisonNodeChangesModalSource, /project-compare-value-diff/);
  assert.match(projectComparisonNodeChangesModalSource, /diffStringsRaw/);
  assert.match(projectComparisonNodeChangesModalSource, /project-compare-diff-marker/);
  assert.match(projectComparisonNodeChangesModalSource, /project-compare-value-diff-before/);
  assert.match(projectComparisonNodeChangesModalSource, /project-compare-value-diff-after/);
  assert.match(projectComparisonNodeChangesModalSource, /PROJECT_COMPARE_NODE_CHANGES_MODAL_WIDTH/);
  assert.match(projectComparisonNodeChangesModalSource, /max\(30vw, min\(968px, calc\(100vw - 48px\)\)\)/);
});

test('graph tree shows compare diagnostics for graphs and folders', () => {
  const graphListSource = source('components/GraphList.tsx');
  const folderItemSource = source('components/graphList/FolderItem.tsx');
  const graphFoldersSource = source('components/graphList/graphFolders.ts');
  const useGraphListPresentationSource = source('components/graphList/useGraphListPresentation.ts');

  assert.match(graphListSource, /activeProjectComparisonState/);
  assert.match(graphListSource, /graphCompareKindByGraphId/);
  assert.match(useGraphListPresentationSource, /activeComparison\.comparison\.graphs/);
  assert.match(useGraphListPresentationSource, /comparison\.kind === 'removed'/);
  assert.match(graphFoldersSource, /addComparisonRemovedGraphsToFolderTree/);
  assert.match(folderItemSource, /getFolderCompareKind/);
  assert.match(folderItemSource, /isComparisonGhost/);
  assert.match(folderItemSource, /graph-compare-badge/);
});

test('host package re-exports the project comparison helper for wrappers', () => {
  const hostSource = source('host.tsx');
  const workspaceHostTypesSource = source('hooks/workspaceHost/types.ts');
  const workspaceHostCompareSource = source('hooks/workspaceHost/useWorkspaceHostCompare.ts');

  assert.match(hostSource, /compareProjects/);
  assert.match(hostSource, /getProjectNodeFieldComparisons/);
  assert.match(hostSource, /ProjectComparisonChangeKind/);
  assert.match(hostSource, /ProjectCompareSideLabels/);
  assert.match(hostSource, /RivetProjectCompareOptions/);
  assert.match(workspaceHostTypesSource, /startProjectCompare\(/);
  assert.match(workspaceHostTypesSource, /stopProjectCompare\(/);
  assert.match(workspaceHostCompareSource, /labels: options\?\.labels/);
  assert.match(workspaceHostCompareSource, /projectCompareReferenceState/);
});
