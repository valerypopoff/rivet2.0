import { useAtom } from 'jotai';
import { projectsState, type OpenedProjectInfo, type OpenedProjectsInfo } from '../state/savedGraphs.js';
import { toast } from 'react-toastify';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { addOpenedProject } from '../utils/openedProjects.js';
import { handleError } from '../utils/errorHandling.js';
import { useWorkspaceTransitions } from './useWorkspaceTransitions.js';

export function useLoadProjectWithFileBrowser() {
  const ioProvider = useIOProvider();
  const [projects, setProjects] = useAtom(projectsState);
  const workspaceTransitions = useWorkspaceTransitions();

  return async () => {
    try {
      await ioProvider.loadProjectData(({ project, evaluation, path }) => {
        const { data, ...projectData } = project;
        const openedProjects = Object.values(projects.openedProjects) as OpenedProjectInfo[];

        if (openedProjects.some((p) => p.fsPath === path)) {
          toast.error(`That project is already open.`);
          return;
        }

        const alreadyOpenedProject = openedProjects.find((p) => p.projectId === project.metadata.id);

        if (alreadyOpenedProject) {
          toast.error(
            `"${alreadyOpenedProject.title} [${
              alreadyOpenedProject.fsPath?.split('/').pop() ?? 'no path'
            }]" shares the same ID (${
              project.metadata.id
            }) and is already open. Please close that project first to open this one.`,
          );
          return;
        }

        void (async () => {
          const loaded = await workspaceTransitions.loadProject({
            project: projectData,
            data,
            fsPath: path,
            evaluationData: evaluation.evaluationData,
            evaluationDatasets: evaluation.evaluationDatasets,
            markClean: true,
          });

          if (loaded) {
            setProjects((prev: OpenedProjectsInfo) =>
              addOpenedProject(prev, project, {
                fsPath: path,
              }),
            );
          }
        })();
      });
    } catch (err) {
      handleError(err, 'Failed to load project from file browser', {
        metadata: {
          openProjectCount: Object.keys(projects.openedProjects).length,
        },
      });
    }
  };
}
