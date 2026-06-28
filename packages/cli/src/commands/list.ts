import { loadProjectFromFile, type GraphId, type Project, type UiGraphId } from '@valerypopoff/rivet2-node';
import type * as yargs from 'yargs';
import { getGraphSummaries, getProjectFile, getUiGraphSummaries } from '../cliRuntime.js';

export type ProjectListArgs = {
  json: boolean;
  projectFile: string;
};

export function makeListCommand<T>(y: yargs.Argv<T>) {
  return y
    .positional('projectFile', {
      describe: 'The project file to inspect',
      type: 'string',
      demandOption: true,
    })
    .option('json', {
      describe: 'Print machine-readable JSON',
      type: 'boolean',
      default: false,
    });
}

export function makeInspectCommand<T>(y: yargs.Argv<T>) {
  return y.positional('projectFile', {
    describe: 'The project file to inspect',
    type: 'string',
    demandOption: true,
  });
}

export async function list(args: ProjectListArgs): Promise<void> {
  const summary = await inspectProject(args.projectFile);
  console.log(args.json ? JSON.stringify(summary, null, 2) : formatProjectInspection(summary));
}

export async function inspect(projectFile: string): Promise<void> {
  console.log(JSON.stringify(await inspectProject(projectFile), null, 2));
}

export type ProjectInspection = {
  graphs: Array<{ id: string; main: boolean; name: string; nodes: number }>;
  libraryNodes: Array<{ id: string; nodeType: string; title: string }>;
  path: string;
  plugins: NonNullable<Project['plugins']>;
  project: {
    description?: string;
    id: string;
    mainGraphId?: string;
    title: string;
  };
  webApps: Array<{ components: number; id: string; name: string }>;
};

export async function inspectProject(projectFile: string): Promise<ProjectInspection> {
  const projectPath = await getProjectFile(projectFile);
  const project = await loadProjectFromFile(projectPath);
  return buildProjectInspection(project, projectPath);
}

export function buildProjectInspection(project: Project, projectPath: string): ProjectInspection {
  const mainGraphId = project.metadata.mainGraphId;

  return {
    graphs: getGraphSummaries(project).map((graph) => ({
      ...graph,
      main: graph.id === mainGraphId,
      nodes: project.graphs[graph.id as GraphId]?.nodes.length ?? 0,
    })),
    libraryNodes: Object.values(project.nodePrefabs ?? {}).map((prefab) => ({
      id: prefab.id,
      nodeType: prefab.sourceNode.type,
      title: prefab.sourceNode.title,
    })),
    path: projectPath,
    plugins: project.plugins ?? [],
    project: {
      description: project.metadata.description,
      id: project.metadata.id,
      mainGraphId,
      title: project.metadata.title,
    },
    webApps: getUiGraphSummaries(project).map((uiGraph) => ({
      ...uiGraph,
      components: project.uiGraphs?.[uiGraph.id as UiGraphId]?.components.length ?? 0,
    })),
  };
}

function formatProjectInspection(summary: ProjectInspection): string {
  const lines = [
    `Project: ${summary.project.title} (${summary.project.id})`,
    `Path: ${summary.path}`,
    `Main graph: ${formatMainGraph(summary)}`,
    '',
    formatSection(
      'Graphs',
      summary.graphs.map((graph) => `${graph.main ? '* ' : '- '}${graph.name} (${graph.id}) - ${graph.nodes} nodes`),
    ),
    formatSection(
      'Web apps',
      summary.webApps.map((webApp) => `- ${webApp.name} (${webApp.id}) - ${webApp.components} components`),
    ),
    formatSection(
      'Node library',
      summary.libraryNodes.map((node) => `- ${node.title} (${node.id}) - ${node.nodeType}`),
    ),
    formatSection(
      'Plugins',
      summary.plugins.map((plugin) => `- ${typeof plugin === 'string' ? plugin : JSON.stringify(plugin)}`),
    ),
  ];

  return lines.filter(Boolean).join('\n');
}

function formatMainGraph(summary: ProjectInspection): string {
  const mainGraph = summary.graphs.find((graph) => graph.main);
  return mainGraph ? `${mainGraph.name} (${mainGraph.id})` : summary.project.mainGraphId ?? 'Not set';
}

function formatSection(title: string, lines: string[]): string {
  return lines.length > 0 ? `${title}:\n${lines.join('\n')}` : `${title}: none`;
}
