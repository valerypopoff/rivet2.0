import type { Page } from '@playwright/test';

export type SeedHostedEditorProjectOptions = {
  graphId: string;
  loaded?: boolean;
  projectId: string;
  projectPath: string;
  title: string;
};

export async function seedHostedEditorProject(page: Page, options: SeedHostedEditorProjectOptions) {
  await page.addInitScript((seed: SeedHostedEditorProjectOptions) => {
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
          },
          graphs: {
            [seed.graphId]: {
              metadata: {
                id: seed.graphId,
                name: 'Main Graph',
                description: '',
              },
              nodes: [],
              connections: [],
            },
          },
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
          },
          openedProjectsSortedIds: [seed.projectId],
        },
        openedProjectSnapshotsState: {},
      }),
    );
  }, options);
}
