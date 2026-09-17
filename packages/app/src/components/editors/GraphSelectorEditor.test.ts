import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const graphSelectorEditorSource = readFileSync(new URL('./GraphSelectorEditor.tsx', import.meta.url), 'utf8');

test('graph selector editor uses the shared project graph option helper', () => {
  assert.match(
    graphSelectorEditorSource,
    /import \{ getProjectGraphSelectorOptions \} from '\.\.\/\.\.\/utils\/graphSelectorOptions';/,
  );
  assert.match(graphSelectorEditorSource, /const graphOptions = getProjectGraphSelectorOptions\(project\.graphs, \{/);
  assert.match(graphSelectorEditorSource, /isSearchable/);
  assert.doesNotMatch(graphSelectorEditorSource, /nanoid/);
});
