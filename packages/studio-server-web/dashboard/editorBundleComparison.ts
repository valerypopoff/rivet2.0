import {
  getSubgraphProjectKey,
  resolveNodePrefabInstance,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { COMPARISON_INSPECTION_PREFIX } from '../../app/src/utils/projectComparisonDocument';
import type {
  BundleComparisonCommand,
  BundleComparisonEditorState,
  BundleComparisonIntent,
  BundleComparisonOwner,
  BundleComparisonPairResult,
} from '../../studio-server-shared/workflow-bundle-comparison-types';
import { postMessageToDashboard } from '../../studio-server-shared/editor-bridge';
import { deserializeProjectAsync } from '../overrides/utils/deserializeProject';
import type { EditorCommandBridgeContext } from './editorCommandBridgeContext';
import { readBundleComparison } from './bundleComparisonApi';
import { handleOpenProjectCommand } from './editorProjectOpenCommands';
import { workflowBundleKey } from './workflowBundleBinding';

const same = (a: BundleComparisonOwner | null | undefined, b: BundleComparisonOwner | null | undefined) =>
  !!a && !!b && a.sessionId === b.sessionId && a.generation === b.generation;
const empty = (id: string, title: string): Project => ({
  metadata: { id: id as ProjectId, title, description: '' },
  graphs: {},
});
const ownerOf = (command: BundleComparisonCommand) => (command.action === 'open' ? command.intent : command.owner);

/** The existing command queue owns activation. This owner only pins references. */
export function createEditorBundleComparison(context: EditorCommandBridgeContext) {
  let pending: AbortController | undefined;
  let latest: BundleComparisonCommand | undefined;
  let active: { intent: BundleComparisonIntent; reference: Project } | undefined;
  let phase: 'idle' | 'reading' | 'activating' | 'attaching' = 'idle';
  let activationRevision = 0;
  let referenceId: string | null = null;
  let virtualId: ProjectId | undefined;
  let virtualOwner: BundleComparisonOwner | undefined;
  let lastReported = '';
  let definitionsAbort: AbortController | undefined;
  let definitionKey = '';
  const generations = new Map<string, number>();
  const cache = new Map<string, { project: Project; bytes: number }>();
  const workspace = () => context.getWorkspace();
  const state = (): BundleComparisonEditorState => {
    const current = workspace().getProjectCompareState();
    return {
      owner: current.owner,
      projectId: current.projectId,
      ...(current.exitedOwner ? { exitedOwner: current.exitedOwner } : {}),
    };
  };
  const publish = (requestId?: string, error?: string, cancelled = false) => {
    const current = { ...state(), ...(error ? { error } : {}), ...(cancelled ? { cancelled: true as const } : {}) };
    const key = JSON.stringify(current);
    if (requestId || key !== lastReported) {
      lastReported = key;
      postMessageToDashboard({ type: 'bundle-comparison-state', state: current, requestId });
    }
  };
  const closeVirtual = async (id = virtualId) => {
    if (!id) return;
    const closed = await workspace().closeProject(id);
    if (!closed && context.getProjects().openedProjects[id])
      throw new Error('The Older-only inspection could not be closed. Close its tab before continuing.');
    if (virtualId === id) {
      virtualId = undefined;
      virtualOwner = undefined;
    }
  };
  async function parse(contents: string, key: string, signal: AbortSignal) {
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.project;
    }
    const project = await deserializeProjectAsync(contents, key, { signal });
    signal.throwIfAborted();
    const bytes = contents.length * 2;
    if (bytes <= 64 * 1048576) {
      cache.set(key, { project, bytes });
      while (cache.size > 8 || [...cache.values()].reduce((sum, p) => sum + p.bytes, 0) > 64 * 1048576)
        cache.delete(cache.keys().next().value!);
    }
    return project;
  }
  // Only the visible Older graph's direct definitions are needed for display.
  // They never enter Newer's dependency store or execution pipeline.
  const loadDefinitions = async () => {
    const selection = active;
    const current = workspace().getProjectCompareState();
    if (!selection || !same(current.owner, selection.intent) || current.projectId !== current.referenceProjectId)
      return;
    const key = `${selection.intent.sessionId}:${selection.intent.generation}:${current.graphId}`;
    if (definitionKey === key) return;
    definitionKey = key;
    definitionsAbort?.abort();
    const abort = new AbortController();
    definitionsAbort = abort;
    const { reference, intent } = selection;
    const graph = current.graphId ? reference.graphs[current.graphId] : undefined;
    const definitions: Record<ProjectId, Project> = {};
    const targets = new Map<string, { projectId: string; revisionId: string }>();
    for (const raw of graph?.nodes ?? []) {
      let node = raw;
      try {
        node = resolveNodePrefabInstance(reference, raw);
      } catch {
        /* Keep saved boundary fallback. */
      }
      const data = node.data as {
        targetProjectId?: string;
        projectId?: string;
        targetVersion?: 'latest' | 'published';
      };
      const id =
        node.type === 'subGraph'
          ? data.targetProjectId
          : node.type === 'referencedGraphAlias'
            ? data.projectId
            : undefined;
      const member = intent.referenceCatalog.projects.find((p) => p.projectId === id);
      const version = node.type === 'subGraph' && data.targetVersion === 'published' ? 'published' : 'latest';
      const revisionId = version === 'published' ? member?.publishedRevisionId : member?.revisionId;
      if (member && revisionId)
        targets.set(
          node.type === 'referencedGraphAlias'
            ? member.projectId
            : getSubgraphProjectKey({ projectId: member.projectId as ProjectId, version }),
          {
            projectId: member.projectId,
            revisionId,
          },
        );
    }
    const entries = [...targets];
    try {
      for (let offset = 0; offset < entries.length; offset += 2) {
        await Promise.all(
          entries.slice(offset, offset + 2).map(async ([projectKey, target]) => {
            try {
              const loaded = await readBundleComparison<BundleComparisonPairResult>(
                'pair',
                { older: { bundleId: intent.referenceCatalog.bundleId, ...target }, newer: null },
                abort.signal,
              );
              if (loaded.older) {
                const project = await parse(
                  loaded.older.contents,
                  `${loaded.older.bundleId}:${target.projectId}:${target.revisionId}`,
                  abort.signal,
                );
                if (project.metadata.id === target.projectId) definitions[projectKey as ProjectId] = project;
              }
            } catch {
              abort.signal.throwIfAborted(); /* Missing/corrupt definitions use captured boundaries. */
            }
          }),
        );
      }
      if (
        !abort.signal.aborted &&
        active === selection &&
        workspace().getProjectCompareState().graphId === current.graphId
      )
        workspace().updateProjectCompareDefinitions(intent, definitions);
    } catch {
      /* Selection cancellation is expected. */
    }
  };
  const unsubscribe = workspace().subscribeProjectCompare(() => {
    const current = workspace().getProjectCompareState();
    const referenceChanged = current.referenceId !== referenceId;
    if (
      (phase === 'reading' && (current.activationRevision !== activationRevision || referenceChanged)) ||
      (phase === 'activating' && referenceChanged && current.referenceId !== null)
    )
      pending?.abort();
    if (phase !== 'idle') return;
    if (active && !same(current.owner, active.intent)) definitionsAbort?.abort();
    publish();
    void loadDefinitions();
  });
  return {
    cancelPending() {
      if (latest?.action === 'open') pending?.abort();
    },
    admit(command: BundleComparisonCommand) {
      if (command.action === 'state') return;
      const owner = ownerOf(command);
      if ((generations.get(owner.sessionId) ?? -1) >= owner.generation) return;
      if (command.action === 'stop' && latest && ownerOf(latest).sessionId !== owner.sessionId) return;
      generations.set(owner.sessionId, owner.generation);
      while (generations.size > 16) generations.delete(generations.keys().next().value!);
      pending?.abort();
      definitionsAbort?.abort();
      pending = new AbortController();
      latest = command;
    },
    async run(command: BundleComparisonCommand) {
      if (command.action === 'state') {
        publish(command.requestId);
        return;
      }
      if (latest !== command) {
        publish(command.requestId);
        return;
      }
      const abort = pending!;
      const current = () => latest === command && !abort.signal.aborted;
      const initial = workspace().getProjectCompareState();
      phase = 'reading';
      activationRevision = initial.activationRevision;
      referenceId = initial.referenceId;
      let error: string | undefined;
      try {
        if (command.action === 'stop') {
          phase = 'attaching';
          const actual = workspace().getProjectCompareState();
          const owned =
            actual.owner?.sessionId === command.owner.sessionId && actual.owner.generation <= command.owner.generation;
          if (owned) {
            const stopped = await workspace().stopProjectCompare(undefined, actual.owner!);
            if (!current() || !stopped) return;
          }
          const inspectionOwner = virtualOwner ?? active?.intent;
          const ownsInspection =
            inspectionOwner?.sessionId === command.owner.sessionId &&
            inspectionOwner.generation <= command.owner.generation;
          // A standalone comparison on this tab is a new owner too.
          if (ownsInspection && !workspace().getProjectCompareState().referenceProjectId) {
            active = undefined;
            phase = 'activating';
            await closeVirtual();
            cache.clear();
          }
          return;
        }
        const intent = command.intent;
        const result = await readBundleComparison<BundleComparisonPairResult>('pair', intent.pair, abort.signal);
        if (!current()) return;
        if (
          !!result.older !== !!intent.pair.older ||
          (result.older &&
            (result.older.bundleId !== intent.pair.older?.bundleId ||
              result.older.revisionId !== intent.pair.older?.revisionId))
        )
          throw new Error('The Older reference response does not match the selected saved version.');
        const reference = result.older
          ? await parse(
              result.older.contents,
              `${result.older.bundleId}:${result.older.projectId}:${result.older.revisionId}`,
              abort.signal,
            )
          : empty('empty-older-reference', 'No Older counterpart');
        if (!current()) return;
        if (result.older && reference.metadata.id !== intent.pair.older?.projectId)
          throw new Error('The Older snapshot has a different project identity.');
        if (
          (result.newer?.projectId ?? null) !== (intent.pair.newer?.projectId ?? null) ||
          (result.newer && result.newer.bundleId !== intent.pair.newer?.bundleId)
        )
          throw new Error('The Newer project has a different identity.');
        let projectId: ProjectId;
        phase = 'activating';
        if (result.newer) {
          const opened = await handleOpenProjectCommand(
            context,
            {
              type: 'open-project',
              path: result.newer.path,
              expectedProjectId: result.newer.projectId,
              replaceCurrent: false,
              preview: false,
              preferredGraphId: intent.preferredGraphId,
              recordGraphHistory: !!intent.preferredGraphId,
            },
            { signal: abort.signal },
          );
          if (!current()) return;
          if (!opened) throw new Error('Project selection changed before the comparison opened.');
          projectId = result.newer.projectId as ProjectId;
          if (workspace().getProjectCompareState().projectId !== projectId)
            throw new Error('The selected Newer project could not be activated.');
          const activated = workspace().getProjectCompareState();
          phase = 'reading';
          activationRevision = activated.activationRevision;
          referenceId = activated.referenceId;
          const verified = await readBundleComparison<BundleComparisonPairResult>(
            'pair',
            { older: null, newer: intent.pair.newer },
            abort.signal,
          );
          if (!current()) return;
          if (verified.newer?.path !== result.newer.path || verified.newer?.projectId !== projectId)
            throw new Error('The Newer project moved while opening. Refresh project matching.');
          const updated = await workspace().updateProjectMetadata(
            projectId,
            {},
            { hostedBundleKey: workflowBundleKey(verified.newer.bundleId), persistedExternally: true },
          );
          if (!current()) return;
          if (!updated) throw new Error('The Newer project binding could not be updated. Choose the project again.');
          phase = 'activating';
          await closeVirtual();
        } else {
          const oldVirtual = virtualId;
          projectId = `${COMPARISON_INSPECTION_PREFIX}${intent.sessionId}:${intent.generation}` as ProjectId;
          const opened = await workspace().openProjectSnapshot({
            project: empty(projectId, `${reference.metadata.title} (Older only)`),
            path: projectId,
          });
          if (opened) {
            virtualId = projectId;
            virtualOwner = intent;
          }
          if (!current()) {
            const actual = workspace().getProjectCompareState();
            const claimed = actual.referenceProjectId === projectId && !same(actual.owner, intent);
            if (opened && !claimed) await closeVirtual();
            return;
          }
          if (!opened) throw new Error('The Older-only inspection could not be opened.');
          if (oldVirtual) await closeVirtual(oldVirtual);
        }
        if (!current()) return;
        phase = 'attaching';
        const started = await workspace().startProjectCompare(reference, reference.metadata.title, {
          labels: intent.labels,
          expectedProjectId: projectId,
          owner: { sessionId: intent.sessionId, generation: intent.generation },
          identity: {
            pairs: intent.pairs.flatMap((p) =>
              p.olderId && p.newerId ? [{ beforeProjectId: p.olderId, afterProjectId: p.newerId }] : [],
            ),
          },
        });
        if (!started || !current()) throw new Error('Project selection changed before the comparison was attached.');
        active = { intent, reference };
        definitionKey = '';
        if (!result.newer) {
          const first = Object.values(reference.graphs)[0];
          if (first?.metadata?.id) workspace().inspectComparisonGraph(first.metadata.id);
        }
      } catch (failure) {
        if (latest === command && !abort.signal.aborted)
          error = failure instanceof Error ? failure.message : 'Could not open bundle comparison.';
      } finally {
        phase = 'idle';
        publish(
          command.requestId,
          error ??
            (abort.signal.aborted && latest === command
              ? 'Project selection changed. Choose a project to compare.'
              : undefined),
          abort.signal.aborted && latest === command,
        );
        if (current()) void loadDefinitions();
      }
    },
    dispose() {
      pending?.abort();
      definitionsAbort?.abort();
      unsubscribe();
      cache.clear();
    },
  };
}
