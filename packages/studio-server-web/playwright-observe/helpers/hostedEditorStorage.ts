import type { Page } from '@playwright/test';

export type SeedHostedEditorProjectOptions = {
  extraOpenedProjects?: Array<{
    graphId: string;
    projectId: string;
    projectPath: string;
    title: string;
  }>;
  extraGraphs?: Array<{
    connections?: unknown[];
    id: string;
    name?: string;
    nodes?: unknown[];
  }>;
  graph?: {
    connections?: unknown[];
    nodes?: unknown[];
  };
  graphId: string;
  loaded?: boolean;
  metadata?: Record<string, unknown>;
  nodePrefabs?: Record<string, { id: string; sourceNode: unknown }>;
  projectId: string;
  projectPath: string;
  title: string;
};

export async function seedHostedEditorProject(page: Page, options: SeedHostedEditorProjectOptions) {
  await page.addInitScript((seed: SeedHostedEditorProjectOptions) => {
    const graph = {
      metadata: {
        id: seed.graphId,
        name: 'Main Graph',
        description: '',
      },
      nodes: seed.graph?.nodes ?? [],
      connections: seed.graph?.connections ?? [],
    };
    const extraGraphs = Object.fromEntries(
      (seed.extraGraphs ?? []).map((extraGraph) => [
        extraGraph.id,
        {
          metadata: {
            id: extraGraph.id,
            name: extraGraph.name ?? extraGraph.id,
            description: '',
          },
          nodes: extraGraph.nodes ?? [],
          connections: extraGraph.connections ?? [],
        },
      ]),
    );

    // The editor persists its active graph separately from the project. Seed both
    // layers so fixtures with graph contents do not open an unrelated blank graph.
    localStorage.setItem('graph', JSON.stringify({ graphState: graph }));
    localStorage.setItem(
      'project',
      JSON.stringify({
        ...(seed.loaded
          ? {
              loadedProjectState: {
                loaded: true,
                path: seed.projectPath,
              },
            }
          : {}),
        projectState: {
          metadata: {
            id: seed.projectId,
            title: seed.title,
            description: '',
            mainGraphId: seed.graphId,
            ...seed.metadata,
          },
          graphs: {
            [seed.graphId]: graph,
            ...extraGraphs,
          },
          ...(seed.nodePrefabs ? { nodePrefabs: seed.nodePrefabs } : {}),
          plugins: [],
        },
        projectsState: {
          openedProjects: {
            [seed.projectId]: {
              projectId: seed.projectId,
              title: seed.title,
              fsPath: seed.projectPath,
              openedGraph: seed.graphId,
            },
            ...Object.fromEntries((seed.extraOpenedProjects ?? []).map((opened) => [opened.projectId, {
              projectId: opened.projectId,
              title: opened.title,
              fsPath: opened.projectPath,
              openedGraph: opened.graphId,
            }])),
          },
          openedProjectsSortedIds: [seed.projectId, ...(seed.extraOpenedProjects ?? []).map((opened) => opened.projectId)],
        },
        openedProjectSnapshotsState: {},
      }),
    );
  }, options);
}
