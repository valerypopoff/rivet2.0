import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { createEmptyEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import type { EditorCommandBridgeContext } from '../dashboard/editorCommandBridgeContext.js';
import { handleRefreshOpenProjectCommand } from '../dashboard/editorProjectOpenCommands.js';
import { bindHostedProjectRevision, getHostedProjectRevisionState } from '../io/hostedProjectRevisionTracker.js';

function fixture() {
  const id = 'inactive' as ProjectId;
  const path = '/workflows/inactive.rivet-project';
  let present = true;
  let commits = 0;
  let replacements = 0;
  const context = {
    getProjects: () => ({
      openedProjectsSortedIds: [id],
      openedProjects: present
        ? {
            [id]: { projectId: id, fsPath: path, title: 'Inactive' },
          }
        : {},
    }),
    openedProjectPathAliases: new Map(),
    getLoadedProject: () => ({ path: '/workflows/active.rivet-project', loaded: true }),
    loadProjectData: async (_path, options) => {
      assert.equal(options?.deferCommit, true);
      assert.equal(options?.activateDatasets, false);
      return {
        project: { metadata: { id, title: 'Inactive', description: '' }, graphs: {} } as Project,
        evaluation: { evaluationData: createEmptyEvaluationProjectData(), evaluationDatasets: [] },
        commit: async (isCurrent) => {
          assert.equal(isCurrent(), true);
          commits++;
          return true;
        },
      };
    },
    getWorkspace: () => ({
      replaceProjectSnapshot: async () => {
        replacements++;
        return true;
      },
    }),
    clearLoadedRecordingForPath: () => {},
  } as unknown as EditorCommandBridgeContext;
  return {
    context,
    path,
    committed: () => commits,
    replaced: () => replacements,
    close: () => {
      present = false;
    },
  };
}

test('inactive refresh commits only validated data without selecting its datasets', async () => {
  const f = fixture();
  assert.equal(
    await handleRefreshOpenProjectCommand(f.context, { type: 'refresh-open-project-from-disk', path: f.path }),
    true,
  );
  assert.equal(f.committed(), 1);
  assert.equal(f.replaced(), 1);
});

test('an inactive tab closed during preparation receives no dataset or snapshot mutation', async () => {
  const f = fixture();
  const load = f.context.loadProjectData;
  f.context.loadProjectData = async (...args) => {
    const result = await load(...args);
    f.close();
    return result;
  };
  assert.equal(
    await handleRefreshOpenProjectCommand(f.context, { type: 'refresh-open-project-from-disk', path: f.path }),
    false,
  );
  assert.equal(f.committed(), 0);
  assert.equal(f.replaced(), 0);
});

test('a cancelled active refresh rolls back its candidate revision without a false error notification', async () => {
  const f = fixture();
  f.context.getLoadedProject = () => ({ path: f.path, loaded: true });
  bindHostedProjectRevision('inactive', f.path, 'original');
  f.context.getOpenProject = () => async () => {
    bindHostedProjectRevision('inactive', f.path, 'candidate');
    return { opened: false };
  };
  // No browser is installed: attempting to post an error would fail this test.
  assert.equal(
    await handleRefreshOpenProjectCommand(f.context, { type: 'refresh-open-project-from-disk', path: f.path }),
    false,
  );
  assert.equal(getHostedProjectRevisionState('inactive')?.acceptedRevisionId, 'original');
});
