import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const actionBarMoreMenuSource = readFileSync(new URL('./ActionBarMoreMenu.tsx', import.meta.url), 'utf8');

test('executor picker immediately persists Browser/Node mode to the active project tab', () => {
  assert.match(actionBarMoreMenuSource, /projectState, projectsState/);
  assert.match(actionBarMoreMenuSource, /updateOpenedProjectExecutorMode/);
  assert.match(actionBarMoreMenuSource, /createLocalProjectExecutorMode/);
  assert.match(actionBarMoreMenuSource, /const currentProject = useAtomValue\(projectState\);/);
  assert.match(actionBarMoreMenuSource, /const setProjects = useSetAtom\(projectsState\);/);
  assert.match(actionBarMoreMenuSource, /setSelectedExecutor\(value\);/);
  assert.match(actionBarMoreMenuSource, /const projectExecutorMode = createLocalProjectExecutorMode\(value\);/);
  assert.match(
    actionBarMoreMenuSource,
    /setProjects\(\(previousProjects\) =>\s+updateOpenedProjectExecutorMode\(previousProjects, projectId, projectExecutorMode\),\s+\);/,
  );
});
