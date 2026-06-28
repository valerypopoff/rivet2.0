import { createProcessor, type LooseDataValue } from '@valerypopoff/rivet2-node';
import { resolve } from 'node:path';
import type * as yargs from 'yargs';
import {
  parseJsonInputRecord,
  parseJsonInputRecordFromFile,
  parseJsonKeyValueInputRecord,
  parseKeyValueInputRecord,
  throwIfConflictingInputSources,
} from '../commandInputs.js';
import {
  loadProjectRuntime,
  throwIfInvalidGraph,
  throwIfNoMainGraph,
  withRuntimeProcessorOptions,
  type DatasetCliOptions,
} from '../cliRuntime.js';
import { shapeOutputs, writeJsonOutput } from '../output.js';

type RunArgs = {
  context: string[];
  contextFile: string | undefined;
  contextJson: string[];
  graphName: string | undefined;
  includeCost: boolean;
  input: string[];
  inputJson: string[];
  inputsFile: string | undefined;
  inputsStdin: boolean;
  outputFile: string | undefined;
  outputKey: string | undefined;
  projectFile: string;
  unwrapOutput: string | undefined;
} & DatasetCliOptions;

export function makeCommand<T>(y: yargs.Argv<T>) {
  return y
    .positional('projectFile', {
      describe: 'The project file to run',
      type: 'string',
      demandOption: true,
    })
    .positional('graphName', {
      describe: 'The name of the graph to run',
      type: 'string',
    })
    .option('inputs-stdin', {
      describe: 'Read inputs from stdin as JSON',
      type: 'boolean',
      default: false,
    })
    .option('inputs-file', {
      describe: 'Read inputs from a JSON file',
      type: 'string',
    })
    .option('input-json', {
      describe: 'Adds a JSON input to the graph run using key=json',
      type: 'string',
      array: true,
      default: [],
    })
    .option('include-cost', {
      describe: 'Include the total cost in the output',
      type: 'boolean',
      default: false,
    })
    .option('output-key', {
      describe: 'Print only one named output Data Value wrapper',
      type: 'string',
    })
    .option('unwrap-output', {
      describe: 'Print only the .value field from one named output',
      type: 'string',
    })
    .option('output-file', {
      describe: 'Write the JSON output to a file instead of stdout',
      type: 'string',
    })
    .option('context', {
      describe: 'Adds a context value to the graph run',
      type: 'string',
      array: true,
      default: [],
    })
    .option('context-json', {
      describe: 'Adds a JSON context value using key=json',
      type: 'string',
      array: true,
      default: [],
    })
    .option('context-file', {
      describe: 'Read context values from a JSON file',
      type: 'string',
    })
    .option('input', {
      describe: 'Adds an input to the graph run',
      type: 'string',
      array: true,
      default: [],
    })
    .option('dataset-file', {
      describe: 'Use a specific .rivet-data file instead of the project-adjacent default',
      type: 'string',
    })
    .option('save-datasets', {
      describe: 'Persist dataset mutations back to the dataset file',
      type: 'boolean',
      default: false,
    })
    .option('require-dataset-file', {
      describe: 'Fail if the dataset file does not exist',
      type: 'boolean',
      default: false,
    });
}

export async function run(args: RunArgs) {
  try {
    const runtime = await loadProjectRuntime(args.projectFile, args);

    throwIfNoMainGraph(runtime.project, args.graphName, runtime.projectPath, 'positional');
    throwIfInvalidGraph(runtime.project, args.graphName, 'positional');

    const { run: runProcessor } = createProcessor(
      runtime.project,
      withRuntimeProcessorOptions(runtime, {
        context: await readContext(args),
        graph: args.graphName,
        inputs: await readInputs(args),
      }),
    );

    await writeJsonOutput(
      shapeOutputs(await runProcessor(), {
        includeCost: args.includeCost,
        outputKey: args.outputKey,
        unwrapOutput: args.unwrapOutput,
      }),
      args.outputFile,
    );
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

async function readInputs(args: RunArgs): Promise<Record<string, LooseDataValue>> {
  throwIfConflictingInputSources(
    [
      { enabled: args.inputsStdin, name: '--inputs-stdin' },
      { enabled: args.inputsFile != null, name: '--inputs-file' },
      { enabled: args.input.length > 0 || args.inputJson.length > 0, name: '--input/--input-json' },
    ],
    'input',
  );

  if (args.inputsStdin) {
    return parseJsonInputRecord(await readStdin(), 'Input stdin');
  }

  if (args.inputsFile) {
    return parseJsonInputRecordFromFile(resolve(process.cwd(), args.inputsFile), 'Input file');
  }

  return {
    ...parseKeyValueInputRecord(args.input, 'input'),
    ...parseJsonKeyValueInputRecord(args.inputJson, 'input-json'),
  };
}

async function readContext(args: RunArgs): Promise<Record<string, LooseDataValue>> {
  throwIfConflictingInputSources(
    [
      { enabled: args.contextFile != null, name: '--context-file' },
      { enabled: args.context.length > 0 || args.contextJson.length > 0, name: '--context/--context-json' },
    ],
    'context',
  );

  if (args.contextFile) {
    return parseJsonInputRecordFromFile(resolve(process.cwd(), args.contextFile), 'Context file');
  }

  return {
    ...parseKeyValueInputRecord(args.context, 'context'),
    ...parseJsonKeyValueInputRecord(args.contextJson, 'context-json'),
  };
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');

  let inputText = '';
  for await (const chunk of process.stdin) {
    inputText += chunk;
  }

  return inputText;
}
