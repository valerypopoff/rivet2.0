import { isComparisonInspectionProject } from '../../utils/projectComparisonDocument.js';

type Groups = Record<string, Record<string, unknown>>;
/** Strip only reserved inspection documents from a captured copy, never live atoms. */
export function excludeComparisonInspection(groups: Groups): Groups {
  const source = groups.project;
  if (!source) return groups;
  const canvas = groups.graph?.graphState as { comparisonReferenceView?: boolean } | undefined;
  if (canvas?.comparisonReferenceView) {
    const project = source.projectState as { graphs?: Record<string, unknown> } | undefined;
    const graph = { ...(groups.graph ?? {}) };
    const authored = Object.values(project?.graphs ?? {})[0];
    if (authored) graph.graphState = authored;
    else delete graph.graphState;
    groups = { ...groups, graph };
  }
  const tabs = source.projectsState as
    | { openedProjects: Record<string, { fsPath?: string; openedGraph?: string }>; openedProjectsSortedIds: string[] }
    | undefined;
  if (!tabs || !Object.keys(tabs.openedProjects).some(isComparisonInspectionProject)) return groups;
  const project = { ...source };
  for (const key of [
    'openedProjectSnapshotsState',
    'savedProjectContentDigestsState',
    'projectUnsavedChangesState',
    'projectDataUnsavedChangesState',
    'projectEditorStateByProjectId',
  ]) {
    const value = project[key];
    if (value && typeof value === 'object' && !Array.isArray(value))
      project[key] = Object.fromEntries(Object.entries(value).filter(([id]) => !isComparisonInspectionProject(id)));
  }
  for (const id of Object.keys(tabs.openedProjects).filter(isComparisonInspectionProject))
    delete project[`projectContext__"${id}"`];
  const ids = tabs.openedProjectsSortedIds.filter((id) => !isComparisonInspectionProject(id));
  project.projectsState = {
    ...tabs,
    openedProjects: Object.fromEntries(
      Object.entries(tabs.openedProjects).filter(([id]) => !isComparisonInspectionProject(id)),
    ),
    openedProjectsSortedIds: ids,
  };
  const active = source.projectState as { metadata?: { id?: string } } | undefined;
  if (!active?.metadata?.id || !isComparisonInspectionProject(active.metadata.id)) return { ...groups, project };
  const snapshots = project.openedProjectSnapshotsState as
    | Record<string, { project: { graphs: Record<string, unknown> }; data?: unknown }>
    | undefined;
  const id = ids.find((id) => snapshots?.[id]);
  const snapshot = id ? snapshots?.[id] : undefined;
  const graph = { ...(groups.graph ?? {}) };
  const graphBuilder = { ...(groups.graphBuilder ?? {}) };
  if (id && snapshot) {
    project.projectState = snapshot.project;
    project.projectDataState = snapshot.data ?? {};
    project.loadedProjectState = {
      loaded: !!tabs.openedProjects[id]?.fsPath,
      path: tabs.openedProjects[id]?.fsPath ?? null,
    };
    const graphId = tabs.openedProjects[id]?.openedGraph;
    const selectedGraph = (graphId && snapshot.project.graphs[graphId]) || Object.values(snapshot.project.graphs)[0];
    if (selectedGraph) graph.graphState = selectedGraph;
    else delete graph.graphState;
  } else {
    delete project.projectState;
    delete project.projectDataState;
    delete project.loadedProjectState;
    delete graph.graphState;
  }
  delete graphBuilder.graphNavigationStackState;
  return { ...groups, project, graph, graphBuilder };
}
