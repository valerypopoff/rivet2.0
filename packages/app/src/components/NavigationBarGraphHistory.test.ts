import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const navigationBarSource = readFileSync(new URL('./NavigationBar.tsx', import.meta.url), 'utf8');
const projectSelectorSource = readFileSync(new URL('./ProjectSelector.tsx', import.meta.url), 'utf8');
const graphTopBarControlsSource = readFileSync(
  new URL('./projectSelector/GraphTopBarControls.tsx', import.meta.url),
  'utf8',
);

test('graph history navigation lives in the project top bar next to the graph-tree toggle', () => {
  assert.match(projectSelectorSource, /{projectTabsSelected && <GraphTreeSidebarToggle \/>}/);
  assert.match(projectSelectorSource, /{projectTabsSelected && <GraphHistoryControls \/>}/);
  assert.match(graphTopBarControlsSource, /<GraphHistoryButton[\s\S]*?disabled={!navigationStack\.hasBackward}/);
  assert.match(graphTopBarControlsSource, /<GraphHistoryButton[\s\S]*?disabled={!navigationStack\.hasForward}/);
  assert.match(graphTopBarControlsSource, /tooltip={GRAPH_HISTORY_PREVIOUS_TOOLTIP}/);
  assert.match(graphTopBarControlsSource, /tooltip={GRAPH_HISTORY_NEXT_TOOLTIP}/);
  assert.match(graphTopBarControlsSource, /<button[\s\S]*?aria-label={label}[\s\S]*?disabled={disabled}/);
  assert.match(graphTopBarControlsSource, /onClick={disabled \? undefined : onClick}/);
  assert.match(graphTopBarControlsSource, /className={clsx\('graph-history-menu', \{ disabled \}\)}/);
  assert.doesNotMatch(projectSelectorSource, /graph-history-button-placeholder/);
  assert.doesNotMatch(navigationBarSource, /graph-history-controls|GraphHistoryButton|useGraphHistoryNavigation/);
  assert.match(navigationBarSource, /<Tooltip content="Close graph search" placement="bottom" tag="span"/);
  assert.match(navigationBarSource, /<Tooltip content="Open graph" placement="right" tag="span"/);
  assert.doesNotMatch(navigationBarSource, /title="Close graph search"/);
  assert.doesNotMatch(navigationBarSource, /title="Open graph"/);
});
