import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduledProjectOptions } from '../dashboard/scheduledProjectOptions';

test('hierarchical project choices expand folders, search hidden descendants, and preserve identities and source data', () => {
  const projects = [
    { id: 'ten', name: 'Job 10', relativePath: 'Work/Nested/ten.rivet-project' },
    { id: 'other', name: 'Job 2', relativePath: 'Other/two.rivet-project' },
    { id: 'two', name: 'Job 2', relativePath: 'Work\\Nested\\two.rivet-project' },
    { id: 'root', name: 'Root', relativePath: 'root.rivet-project' },
  ];
  const before = structuredClone(projects);
  const expanded = new Set<string>();
  assert.deepEqual(
    scheduledProjectOptions(projects, expanded, '').map((option) => option.label),
    ['Other', 'Work', 'Root'],
  );
  expanded.add('Work');
  assert.deepEqual(
    scheduledProjectOptions(projects, expanded, '').map((option) => [option.label, option.depth]),
    [
      ['Other', 0],
      ['Work', 0],
      ['Nested', 1],
      ['Root', 0],
    ],
  );
  expanded.add('Work/Nested');
  const visible = scheduledProjectOptions(projects, expanded, '');
  assert.deepEqual(
    visible.filter((option) => option.kind === 'project').map((option) => option.value),
    ['two', 'ten', 'root'],
  );
  assert.equal(visible.find((option) => option.value === 'two')!.path, 'Work/Nested/two.rivet-project');
  assert.equal(visible.find((option) => option.value === 'two')!.depth, 2);
  const search = scheduledProjectOptions(projects, new Set(), '  WORK/NESTED  ');
  assert.deepEqual(
    search.map((option) => option.value),
    ['folder:Work', 'folder:Work/Nested', 'two', 'ten'],
  );
  assert.ok(search.filter((option) => option.kind === 'folder').every((option) => option.expanded));
  assert.deepEqual(
    scheduledProjectOptions(projects, new Set(), 'Job 2')
      .filter((option) => option.kind === 'project')
      .map((option) => option.value),
    ['other', 'two'],
  );
  assert.deepEqual(scheduledProjectOptions(projects, expanded, 'missing'), []);
  assert.deepEqual(scheduledProjectOptions([], expanded, ''), []);
  assert.deepEqual(projects, before);
  assert.deepEqual([...expanded], ['Work', 'Work/Nested']);
});
