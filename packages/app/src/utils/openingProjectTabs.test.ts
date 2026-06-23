import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpeningProjectTabInfo } from '../state/openingProjectTabs.js';
import { buildProjectTabListItems, getWorkspaceVisibleTabCount } from './openingProjectTabs.js';

const projectId = (id: string) => id as ProjectId;

function openingTab(openingTabId: string, patch: Partial<OpeningProjectTabInfo> = {}): OpeningProjectTabInfo {
  return {
    openingTabId,
    path: null,
    title: openingTabId,
    ...patch,
  };
}

test('buildProjectTabListItems appends opening project tabs after real project tabs', () => {
  assert.deepEqual(
    buildProjectTabListItems({
      openedProjectIds: [projectId('a'), projectId('b')],
      openingTabIds: ['opening-1'],
      openingTabs: {
        'opening-1': openingTab('opening-1'),
      },
    }),
    [
      { type: 'project', projectId: 'a' },
      { type: 'project', projectId: 'b' },
      { type: 'opening', openingTabId: 'opening-1' },
    ],
  );
});

test('buildProjectTabListItems visually replaces a target project tab with an opening tab', () => {
  const tabListInput = {
    openedProjectIds: [projectId('a'), projectId('b'), projectId('c')],
    openingTabIds: ['opening-1'],
    openingTabs: {
      'opening-1': openingTab('opening-1', {
        replaceTargetProjectId: projectId('b'),
      }),
    },
  };

  assert.deepEqual(buildProjectTabListItems(tabListInput), [
    { type: 'project', projectId: 'a' },
    { type: 'opening', openingTabId: 'opening-1' },
    { type: 'project', projectId: 'c' },
  ]);
  assert.equal(getWorkspaceVisibleTabCount(tabListInput), 3);
});

test('buildProjectTabListItems ignores stale opening tab ids and appends missing replacement targets', () => {
  assert.deepEqual(
    buildProjectTabListItems({
      openedProjectIds: [projectId('a')],
      openingTabIds: ['missing', 'opening-1'],
      openingTabs: {
        'opening-1': openingTab('opening-1', {
          replaceTargetProjectId: projectId('closed'),
        }),
      },
    }),
    [
      { type: 'project', projectId: 'a' },
      { type: 'opening', openingTabId: 'opening-1' },
    ],
  );
});

test('getWorkspaceVisibleTabCount counts appended opening tabs as visible tabs', () => {
  assert.equal(
    getWorkspaceVisibleTabCount({
      openedProjectIds: [projectId('a')],
      openingTabIds: ['opening-1', 'opening-2'],
      openingTabs: {
        'opening-1': openingTab('opening-1'),
        'opening-2': openingTab('opening-2'),
      },
    }),
    3,
  );
});
