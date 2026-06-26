import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

test('Node Library add menu keeps graph-reference and linked-node entries out of source creation', () => {
  const source = readFileSync(join(testDir, 'useContextMenuAddNodeConfiguration.ts'), 'utf8');

  assert.match(source, /x\.type === 'referencedGraphAlias' \|\| x\.type === NODE_PREFAB_INSTANCE_TYPE/);
  assert.match(source, /if \(!nodeLibraryOpen\) \{[\s\S]*const type: BuiltInNodeType = 'referencedGraphAlias'/);
  assert.match(source, /if \(!nodeLibraryOpen && Object\.values\(referencedProjects\)\.length > 0\)/);
});
