import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, ProjectId } from '@valerypopoff/rivet2-core';
import { createEmptyEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';
import type { EditorCommandBridgeContext } from '../dashboard/editorCommandBridgeContext.js';
import { handleRefreshOpenProjectCommand } from '../dashboard/editorProjectOpenCommands.js';
import { handleDeleteWorkflowProjectCommand } from '../dashboard/editorProjectLifecycleCommands.js';
import {
  bindHostedProjectRevision,
  clearHostedProjectRevisionPath,
  getHostedProjectRevisionState,
} from '../io/hostedProjectRevisionTracker.js';
import {
  clearOpenedProjectSession,
  getOpenedProjectSession,
  primeOpenedProjectSession,
} from '../io/openedProjectSessionCache.js';

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

test('a cancelled active refresh rolls back its candidate revision without a false error notification', async (t) => {
  const f = fixture();
  t.after(() => clearHostedProjectRevisionPath(undefined, 'inactive'));
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

test('deletion follows project identity after a path is reused and preserves path-only compatibility', async (t) => {
  for (const scenario of ['moved', 'already closed', 'path only'] as const) {
    await t.test(scenario, async (t) => {
      const deletedId = `deleted-${scenario}` as ProjectId;
      const replacementId = `replacement-${scenario}` as ProjectId;
      const deletedPath = `/workflows/${scenario}.rivet-project`;
      const movedPath = `/workflows/moved-${scenario}.rivet-project`;
      const deletedTabPath = scenario === 'moved' ? movedPath : deletedPath;
      const replacementPath = scenario === 'path only' ? '/workflows/Other.rivet-project' : deletedPath;
      const pathForProject = (id: ProjectId) => (id === deletedId ? deletedTabPath : replacementPath);
      const openedIds = scenario === 'already closed' ? [replacementId] : [deletedId, replacementId];
      const closed: ProjectId[] = [];
      const cleared: ProjectId[] = [];
      const previewsCleared: ProjectId[] = [];
      let loadedClosed = false;
      const currentId = scenario === 'path only' ? deletedId : replacementId;
      const evaluation = { evaluationData: createEmptyEvaluationProjectData(), evaluationDatasets: [] };
      for (const id of [deletedId, replacementId]) {
        const path = pathForProject(id);
        bindHostedProjectRevision(id, path, 'saved');
        primeOpenedProjectSession(id, { fsPath: path, evaluation });
        t.after(() => {
          clearHostedProjectRevisionPath(undefined, id);
          clearOpenedProjectSession(id);
        });
      }
      const aliases = new Map([
        [replacementPath, replacementId],
        [movedPath, deletedId],
      ]);
      const context = {
        getProjects: () => ({
          openedProjectsSortedIds: openedIds,
          openedProjects: Object.fromEntries(
            openedIds.map((id) => [id, { projectId: id, fsPath: pathForProject(id) }]),
          ),
        }),
        getCurrentProject: () => ({ metadata: { id: currentId } }),
        getLoadedProject: () => ({ loaded: true, path: deletedPath }),
        markLoadedProjectClosed: () => {
          loadedClosed = true;
        },
        openedProjectPathAliases: aliases,
        preview: {
          previewProjectRef: { current: { projectId: currentId } },
          clearPreviewProject: (value: { projectId: ProjectId }) => previewsCleared.push(value.projectId),
        },
        getWorkspace: () => ({
          closeProject: async (id: ProjectId) => {
            closed.push(id);
            return true;
          },
          deleteProjectContext: async (id: ProjectId) => {
            cleared.push(id);
          },
        }),
      } as unknown as EditorCommandBridgeContext;
      await handleDeleteWorkflowProjectCommand(context, {
        type: 'delete-workflow-project',
        path: scenario === 'path only' ? deletedPath.replaceAll('/', '\\') : deletedPath,
        ...(scenario === 'path only' ? {} : { projectId: deletedId }),
      });

      assert.deepEqual(closed, scenario === 'already closed' ? [] : [deletedId]);
      assert.deepEqual(cleared, [deletedId]);
      assert.deepEqual(previewsCleared, scenario === 'path only' ? [deletedId] : []);
      assert.equal(loadedClosed, false);
      assert.equal(aliases.get(replacementPath), replacementId);
      assert.equal(aliases.has(movedPath), false);
      assert.equal(getHostedProjectRevisionState(deletedId), null);
      assert.equal(getHostedProjectRevisionState(replacementId)?.acceptedRevisionId, 'saved');
      assert.equal(getOpenedProjectSession(deletedId), null);
      assert.deepEqual(getOpenedProjectSession(replacementId, replacementPath), evaluation);
    });
  }
});
