import { loadProjectFromFile, type Project, type ProjectReference } from '@valerypopoff/rivet2-node';
import { access } from 'node:fs/promises';
import type * as yargs from 'yargs';
import {
  addDatasetOptions,
  findGraph,
  getGraphSummaries,
  getProjectFile,
  getUiGraphSummaries,
  resolveDatasetFilePath,
  type DatasetCliOptions,
} from '../cliRuntime.js';

export type DoctorArgs = {
  json: boolean;
  projectFile: string;
} & DatasetCliOptions;

export type DoctorCheckStatus = 'ok' | 'warning' | 'error';

export type DoctorCheck = {
  id: string;
  message: string;
  status: DoctorCheckStatus;
};

export type DoctorReport = {
  checks: DoctorCheck[];
  ok: boolean;
  path: string;
  summary: {
    errors: number;
    warnings: number;
  };
};

export function makeDoctorCommand<T>(y: yargs.Argv<T>) {
  const command = y
    .positional('projectFile', {
      describe: 'The project file to check',
      type: 'string',
      demandOption: true,
    })
    .option('json', {
      describe: 'Print machine-readable JSON',
      type: 'boolean',
      default: false,
    });

  return addDatasetOptions(command, { includeSaveDatasets: false });
}

export async function doctor(args: DoctorArgs): Promise<void> {
  const report = await buildDoctorReport(args.projectFile, args);
  console.log(args.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));

  if (!report.ok) {
    process.exitCode = 1;
  }
}

export async function buildDoctorReport(
  projectFile: string,
  options: DatasetCliOptions = {},
): Promise<DoctorReport> {
  const projectPath = await getProjectFile(projectFile);
  const project = await loadProjectFromFile(projectPath);
  const checks = [
    buildProjectCheck(project),
    buildGraphCheck(project),
    buildMainGraphCheck(project),
    buildWebAppCheck(project),
    buildNodeLibraryCheck(project),
    buildPluginCheck(project),
    buildProjectReferenceCheck(project.references ?? []),
    await buildDatasetCheck(projectPath, options),
  ];
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const errors = checks.filter((check) => check.status === 'error').length;

  return {
    checks,
    ok: errors === 0,
    path: projectPath,
    summary: {
      errors,
      warnings,
    },
  };
}

function buildProjectCheck(project: Project): DoctorCheck {
  return {
    id: 'project-file',
    message: `Loaded project "${project.metadata.title}" (${project.metadata.id}).`,
    status: 'ok',
  };
}

function buildGraphCheck(project: Project): DoctorCheck {
  const graphs = getGraphSummaries(project);

  return graphs.length > 0
    ? {
        id: 'graphs',
        message: `Found ${formatCount(graphs.length, 'graph')}.`,
        status: 'ok',
      }
    : {
        id: 'graphs',
        message: 'No workflow graphs found.',
        status: 'error',
      };
}

function buildMainGraphCheck(project: Project): DoctorCheck {
  const mainGraphId = project.metadata.mainGraphId;

  if (!mainGraphId) {
    return {
      id: 'main-graph',
      message: 'No main graph is set. Commands must specify a graph explicitly.',
      status: 'warning',
    };
  }

  const mainGraph = findGraph(project, mainGraphId);

  return mainGraph
    ? {
        id: 'main-graph',
        message: `Main graph resolves to "${mainGraph.name}" (${mainGraph.id}).`,
        status: 'ok',
      }
    : {
        id: 'main-graph',
        message: `Main graph "${mainGraphId}" is set but does not exist.`,
        status: 'error',
      };
}

function buildWebAppCheck(project: Project): DoctorCheck {
  const uiGraphs = getUiGraphSummaries(project);

  return {
    id: 'web-apps',
    message:
      uiGraphs.length > 0
        ? `Found ${formatCount(uiGraphs.length, 'Rivet web app')}.`
        : 'No Rivet web apps found.',
    status: 'ok',
  };
}

function buildNodeLibraryCheck(project: Project): DoctorCheck {
  const libraryNodes = Object.values(project.nodePrefabs ?? {});

  return {
    id: 'node-library',
    message:
      libraryNodes.length > 0
        ? `Found ${formatCount(libraryNodes.length, 'Node Library item')}.`
        : 'No Node Library items found.',
    status: 'ok',
  };
}

function buildPluginCheck(project: Project): DoctorCheck {
  const plugins = project.plugins ?? [];

  return {
    id: 'plugins',
    message:
      plugins.length > 0
        ? `Project declares ${formatCount(plugins.length, 'plugin')}: ${plugins.map(formatPlugin).join(', ')}.`
        : 'No plugins declared.',
    status: 'ok',
  };
}

function buildProjectReferenceCheck(references: ProjectReference[]): DoctorCheck {
  const missingHints = references.filter((reference) => !reference.hintPaths || reference.hintPaths.length === 0);

  if (references.length === 0) {
    return {
      id: 'project-references',
      message: 'No project references declared.',
      status: 'ok',
    };
  }

  if (missingHints.length > 0) {
    return {
      id: 'project-references',
      message: `${formatCount(missingHints.length, 'project reference')} has no hint paths. Runtime resolution may depend on the host loader.`,
      status: 'warning',
    };
  }

  return {
    id: 'project-references',
    message: `Found ${formatCount(references.length, 'project reference')} with hint paths.`,
    status: 'ok',
  };
}

async function buildDatasetCheck(projectPath: string, options: DatasetCliOptions): Promise<DoctorCheck> {
  const datasetPath = resolveDatasetFilePath(projectPath, options.datasetFile);

  if (await fileExists(datasetPath)) {
    return {
      id: 'dataset-file',
      message: `Dataset file found at ${datasetPath}.`,
      status: 'ok',
    };
  }

  return {
    id: 'dataset-file',
    message: `Dataset file not found at ${datasetPath}; runs will start without datasets.`,
    status: options.requireDatasetFile ? 'error' : 'ok',
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatDoctorReport(report: DoctorReport): string {
  const status = report.ok ? 'OK' : 'Needs attention';
  const lines = [
    'Rivet project doctor',
    `Path: ${report.path}`,
    `Status: ${status} (${report.summary.errors} errors, ${report.summary.warnings} warnings)`,
    '',
    ...report.checks.map((check) => `${formatCheckStatus(check.status)} ${check.message}`),
  ];

  return lines.join('\n');
}

function formatCheckStatus(status: DoctorCheckStatus): string {
  return status === 'ok' ? '[ok]  ' : status === 'warning' ? '[warn]' : '[err] ';
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function formatPlugin(plugin: NonNullable<Project['plugins']>[number]): string {
  return typeof plugin === 'string' ? plugin : JSON.stringify(plugin);
}
