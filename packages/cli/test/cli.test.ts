import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  serializeProject,
  type ChartNode,
  type GraphId,
  type NodeId,
  type NodePrefabId,
  type PortId,
  type Project,
  type ProjectId,
  type UiComponentId,
  type UiGraphId,
} from '@valerypopoff/rivet2-node';
import yargs from 'yargs';
import { parseJsonInputRecord, parseJsonKeyValueInputRecord, parseKeyValueInputRecord } from '../src/commandInputs.js';
import { buildDoctorReport, makeDoctorCommand } from '../src/commands/doctor.js';
import { buildProjectInspection } from '../src/commands/list.js';
import { makeCommand as makeRunCommand, run } from '../src/commands/run.js';
import {
  buildGraphProcessorOptions,
  buildStreamEventFilter,
  buildStreamingGraphProcessorOptions,
  createServeApp,
  makeCommand as makeServeCommand,
  parseEndpointAliases,
  type ServeArgs,
} from '../src/commands/serve.js';
import { createWebAppServeApp, makeCommand as makeServeAppCommand, type ServeAppArgs } from '../src/commands/serveApp.js';
import { resolveDatasetFilePath, throwIfInvalidGraph, throwIfNoMainGraph } from '../src/cliRuntime.js';
import { formatListenUrl } from '../src/http.js';
import { shapeOutputs } from '../src/output.js';

test('run command builder registers its default option values', async () => {
  const command = makeRunCommand(yargs([])).exitProcess(false);
  const options = command.getOptions();

  assert.deepEqual(options.default.input, []);
  assert.deepEqual(options.default.context, []);
  assert.equal(options.key.input, true);
  assert.equal(options.key['input-json'], true);
  assert.equal(options.key['inputs-file'], true);
  assert.equal(options.key.context, true);
  assert.equal(options.key['context-json'], true);
  assert.equal(options.key['context-file'], true);
  assert.equal(options.key['include-cost'], true);
  assert.equal(options.key['inputs-stdin'], true);
  assert.equal(options.key['dataset-file'], true);
  assert.equal(options.key['save-datasets'], true);
  assert.equal(options.key['openai-api-key'], true);
  assert.equal(options.key['openai-endpoint'], true);
  assert.equal(options.key['openai-organization'], true);
});

test('serve command exposes its expected defaults', async () => {
  const argv = await makeServeCommand(yargs([]))
    .exitProcess(false)
    .parse();

  assert.equal(argv.port, 3000);
  assert.equal(argv.host, '0.0.0.0');
  assert.equal(argv.dev, false);
  assert.equal(argv.allowSpecifyingGraphId, false);
  assert.equal(argv.exposeCost, false);
  assert.deepEqual(argv.endpoint, []);
  assert.deepEqual(argv.corsOrigin, []);
});

test('serve commands parse custom host bindings', async () => {
  const serveArgs = await makeServeCommand(yargs(['project.rivet-project', '--host', '127.0.0.1']))
    .exitProcess(false)
    .parse();
  const serveAppArgs = await makeServeAppCommand(yargs(['project.rivet-project', '--host', '127.0.0.1']))
    .exitProcess(false)
    .parse();

  assert.equal(serveArgs.host, '127.0.0.1');
  assert.equal(serveAppArgs.host, '127.0.0.1');
});

test('formatListenUrl renders IPv4, hostnames, and IPv6 host bindings', () => {
  assert.equal(formatListenUrl('0.0.0.0', 3000), 'http://0.0.0.0:3000');
  assert.equal(formatListenUrl('localhost', 3000), 'http://localhost:3000');
  assert.equal(formatListenUrl('::1', 3000), 'http://[::1]:3000');
});

test('resolveDatasetFilePath handles project extensions case-insensitively', () => {
  assert.equal(resolveDatasetFilePath('Example.RIVET-PROJECT'), 'Example.rivet-data');
});

test('serve-app command exposes its expected defaults', () => {
  const command = makeServeAppCommand(yargs([])).exitProcess(false);
  const options = command.getOptions();

  assert.equal(options.default.port, 3000);
  assert.equal(options.default.host, '0.0.0.0');
  assert.equal(options.default['base-path'], '/');
  assert.equal(options.default.dev, false);
  assert.deepEqual(options.default['cors-origin'], []);
  assert.equal(options.key['openai-api-key'], true);
  assert.equal(options.key['openai-endpoint'], true);
  assert.equal(options.key['openai-organization'], true);
});

test('doctor command exposes dataset and JSON options', () => {
  const command = makeDoctorCommand(yargs([])).exitProcess(false);
  const options = command.getOptions();

  assert.equal(options.default.json, false);
  assert.equal(options.default['require-dataset-file'], false);
  assert.equal(options.key['dataset-file'], true);
  assert.equal(options.key['require-dataset-file'], true);
});

test('run command executes a real project and writes shaped output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rivet-cli-run-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));

  const outputFile = join(directory, 'output.json');
  await run({
    ...buildRunArgs(),
    graphName: 'Passthrough',
    input: ['input=hello'],
    outputFile,
    projectFile: resolve('cli-example.rivet-project'),
    unwrapOutput: 'output',
  });

  assert.equal(await readFile(outputFile, 'utf8'), '"hello"\n');
});

test('run command can persist dataset mutations through the project-adjacent data file', async (t) => {
  const projectFile = await writeTemporaryProject(t, createDatasetAppendProject());
  const outputFile = join(dirname(projectFile), 'output.json');

  await run({
    ...buildRunArgs(),
    graphName: 'Append',
    inputJson: ['data=["alpha","beta"]'],
    outputFile,
    projectFile,
    saveDatasets: true,
    unwrapOutput: 'datasetId',
  });

  assert.equal(await readFile(outputFile, 'utf8'), '"dataset"\n');
  assert.match(await readFile(projectFile.replace(/\.rivet-project$/, '.rivet-data'), 'utf8'), /alpha/);
});

test('run command rejects conflicting output selectors before loading the project', async () => {
  await assert.rejects(
    () =>
      run({
        ...buildRunArgs(),
        outputKey: 'output',
        projectFile: 'missing-project.rivet-project',
        unwrapOutput: 'output',
      }),
    /Use only one output selector/,
  );
});

test('graph validation messages match positional and option command styles', () => {
  const project = createProjectWithWebApp();
  delete project.metadata.mainGraphId;

  assert.throws(
    () => throwIfNoMainGraph(project, undefined, 'project.rivet-project', 'positional'),
    /rivet run project\.rivet-project main/,
  );
  assert.throws(
    () => throwIfNoMainGraph(project, undefined, 'project.rivet-project', 'option'),
    /rivet serve project\.rivet-project --graph main/,
  );

  const projectWithMainGraph = createProjectWithWebApp();
  assert.throws(() => throwIfInvalidGraph(projectWithMainGraph, 'Mian', 'positional'), /Did you mean `"main"`/);
  assert.throws(() => throwIfInvalidGraph(projectWithMainGraph, 'Mian', 'option'), /Did you mean `--graph "main"`/);
});

test('parseKeyValueInputRecord keeps empty and equals-containing values', () => {
  assert.deepEqual(parseKeyValueInputRecord(['name=Rivet=2', 'empty='], 'input'), {
    name: 'Rivet=2',
    empty: '',
  });
});

test('parseKeyValueInputRecord rejects entries without a key separator', () => {
  assert.throws(() => parseKeyValueInputRecord(['missing'], 'input'), /Expected key=value/);
  assert.throws(() => parseKeyValueInputRecord(['=value'], 'input'), /Expected key=value/);
});

test('parseJsonInputRecord accepts objects and treats empty request bodies as no inputs', () => {
  assert.deepEqual(parseJsonInputRecord('', 'Request body'), {});
  assert.deepEqual(parseJsonInputRecord('{"input":"value"}', 'Request body'), { input: 'value' });
  assert.deepEqual(parseJsonInputRecord('{"input":{"nested":true}}', 'Request body'), {
    input: {
      type: 'object',
      value: { nested: true },
    },
  });
});

test('parseJsonInputRecord infers safe JSON array Data Values', () => {
  assert.deepEqual(
    parseJsonInputRecord(
      JSON.stringify({
        empty: [],
        flags: [true, false],
        mixed: [1, 'two'],
        numbers: [1, 2],
        objects: [{ name: 'Alice' }],
        strings: ['a', 'b'],
      }),
      'Request body',
    ),
    {
      empty: { type: 'any[]', value: [] },
      flags: { type: 'boolean[]', value: [true, false] },
      mixed: { type: 'any[]', value: [1, 'two'] },
      numbers: { type: 'number[]', value: [1, 2] },
      objects: { type: 'object[]', value: [{ name: 'Alice' }] },
      strings: { type: 'string[]', value: ['a', 'b'] },
    },
  );
});

test('parseJsonInputRecord rejects arrays and primitive JSON values', () => {
  assert.throws(() => parseJsonInputRecord('[1,2]', 'Request body'), /must be a JSON object/);
  assert.throws(() => parseJsonInputRecord('"value"', 'Request body'), /must be a JSON object/);
});

test('parseJsonKeyValueInputRecord parses structured input values', () => {
  assert.deepEqual(parseJsonKeyValueInputRecord(['count=2', 'payload={"ok":true}'], 'input-json'), {
    count: 2,
    payload: {
      type: 'object',
      value: { ok: true },
    },
  });
});

test('buildStreamEventFilter filters SSE events when --stream names a node', () => {
  assert.deepEqual(buildStreamEventFilter(undefined), {
    nodeStart: true,
    nodeFinish: true,
    partialOutputs: true,
  });

  assert.deepEqual(buildStreamEventFilter(' Chat Node '), {
    nodeStart: ['Chat Node'],
    nodeFinish: ['Chat Node'],
    partialOutputs: ['Chat Node'],
  });
});

test('serve processor options keep non-streaming runs on the default runtime policy', () => {
  const options = buildGraphProcessorOptions({
    graph: 'Main',
    inputs: { input: 'value' },
    openaiApiKey: undefined,
    openaiEndpoint: undefined,
    openaiOrganization: undefined,
  });

  assert.equal('runtimeProfile' in options, false);
  assert.equal('openAiKey' in options, false);
  assert.equal(options.graph, 'Main');
  assert.deepEqual(options.inputs, { input: 'value' });
});

test('serve processor options include only explicit provider overrides', () => {
  const options = buildGraphProcessorOptions({
    graph: 'Main',
    inputs: {},
    openaiApiKey: 'key',
    openaiEndpoint: 'https://example.test/v1',
    openaiOrganization: undefined,
  });

  assert.equal(options.openAiKey, 'key');
  assert.equal(options.openAiEndpoint, 'https://example.test/v1');
  assert.equal('openAiOrganization' in options, false);
});

test('serve streaming runs force the compatible runtime policy', () => {
  const options = buildStreamingGraphProcessorOptions({
    graph: 'Main',
    inputs: { input: 'value' },
    openaiApiKey: undefined,
    openaiEndpoint: undefined,
    openaiOrganization: undefined,
  });

  assert.equal(options.runtimeProfile, 'compatible');
  assert.equal(options.graph, 'Main');
  assert.deepEqual(options.inputs, { input: 'value' });
});

test('createServeApp rejects single-node streaming without event streaming enabled', async () => {
  await assert.rejects(
    () =>
      createServeApp({
        ...buildServeArgs(),
        graph: 'Passthrough',
        streamNode: 'Chat',
      }),
    /--stream-node requires --stream/,
  );
});

test('shapeOutputs can select and unwrap graph outputs', () => {
  const outputs = {
    cost: { type: 'number', value: 1 },
    output: { type: 'string', value: 'hello' },
  };

  assert.deepEqual(shapeOutputs(outputs, {}), {
    output: { type: 'string', value: 'hello' },
  });
  assert.deepEqual(shapeOutputs(outputs, { outputKey: 'output' }), { type: 'string', value: 'hello' });
  assert.equal(shapeOutputs(outputs, { unwrapOutput: 'output' }), 'hello');
  assert.throws(() => shapeOutputs(outputs, { outputKey: 'missing' }), /was not returned/);
  assert.throws(() => shapeOutputs(outputs, { outputKey: 'output', unwrapOutput: 'output' }), /Use only one/);
});

test('parseEndpointAliases validates aliases and duplicate endpoint names', async () => {
  const { loadProjectFromFile } = await import('@valerypopoff/rivet2-node');
  const project = await loadProjectFromFile(resolve('cli-example.rivet-project'));

  assert.deepEqual([...parseEndpointAliases(['pass=Passthrough'], project)], [['pass', 'Passthrough']]);
  assert.throws(() => parseEndpointAliases(['pass=Passthrough', 'pass=Passthrough Context'], project), /Duplicate/);
  assert.throws(() => parseEndpointAliases(['bad name=Passthrough'], project), /Invalid endpoint name/);
  assert.throws(() => parseEndpointAliases(['missing=Nope'], project), /Graph "Nope" not found/);
});

test('createServeApp exposes health, auth, CORS, and endpoint aliases', async () => {
  const { app } = await createServeApp({
    ...buildServeArgs(),
    bearerToken: 'secret',
    corsOrigin: ['https://example.test'],
    endpoint: ['pass=Passthrough'],
    graph: 'Passthrough',
  });

  const healthResponse = await app.fetch(new Request('http://localhost/healthz'));
  assert.equal(healthResponse.status, 200);

  const unauthorizedResponse = await app.fetch(
    new Request('http://localhost/endpoints/pass', {
      body: '{"input":"hello"}',
      method: 'POST',
    }),
  );
  assert.equal(unauthorizedResponse.status, 401);

  const response = await app.fetch(
    new Request('http://localhost/endpoints/pass', {
      body: '{"input":"hello"}',
      headers: {
        authorization: 'Bearer secret',
        origin: 'https://example.test',
      },
      method: 'POST',
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.test');
  assert.equal(response.headers.has('x-duration-ms'), true);

  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body.output, { type: 'string', value: 'hello' });

  const invalidJsonResponse = await app.fetch(
    new Request('http://localhost/endpoints/pass', {
      body: 'not-json',
      headers: { authorization: 'Bearer secret' },
      method: 'POST',
    }),
  );
  assert.equal(invalidJsonResponse.status, 400);
  assert.match(await invalidJsonResponse.text(), /Request body must be valid JSON/);
});

test('createServeApp returns an SSE response in streaming mode', async () => {
  const { app } = await createServeApp({
    ...buildServeArgs(),
    graph: 'Passthrough',
    stream: '',
  });

  const response = await app.fetch(
    new Request('http://localhost/', {
      body: '{"input":"hello"}',
      method: 'POST',
    }),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  await response.body?.cancel();
});

test('createWebAppServeApp serves app JSON and rejects stale revision keys', async (t) => {
  const projectFile = await writeTemporaryProject(t, createProjectWithWebApp());
  const { app } = await createWebAppServeApp({
    ...buildServeAppArgs(),
    corsOrigin: ['https://example.test'],
    projectFile,
    revisionKey: 'current',
  });

  const htmlResponse = await app.fetch(
    new Request('http://localhost/', {
      headers: { origin: 'https://example.test' },
    }),
  );
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get('access-control-allow-origin'), 'https://example.test');

  const appResponse = await app.fetch(new Request('http://localhost/app.json'));
  assert.equal(appResponse.status, 200);
  assert.equal((await appResponse.json() as { name: string }).name, 'Test web app');

  const actionResponse = await app.fetch(
    new Request('http://localhost/actions/run', {
      body: JSON.stringify({
        componentId: 'button',
        revisionKey: 'current',
        state: { prompt: 'hello' },
      }),
      method: 'POST',
    }),
  );
  assert.equal(actionResponse.status, 200);
  assert.deepEqual(await actionResponse.json(), {
    outputs: {
      answer: {
        type: 'string',
        value: 'hello',
      },
      cost: {
        type: 'number',
        value: 0,
      },
    },
    statePatch: {
      result: 'hello',
    },
  });

  const staleActionResponse = await app.fetch(
    new Request('http://localhost/actions/run', {
      body: JSON.stringify({
        componentId: 'button',
        revisionKey: 'stale',
        state: {},
      }),
      method: 'POST',
    }),
  );
  assert.equal(staleActionResponse.status, 409);
  assert.deepEqual(await staleActionResponse.json(), {
    code: 'revision_mismatch',
    error: 'Rivet web app revision mismatch.',
  });
});

test('createWebAppServeApp dev mode rereads the project file for web app routes', async (t) => {
  const project = createProjectWithWebApp();
  const projectFile = await writeTemporaryProject(t, project);
  const { app } = await createWebAppServeApp({
    ...buildServeAppArgs(),
    dev: true,
    projectFile,
  });

  project.uiGraphs!.app!.name = 'Changed web app';
  project.uiGraphs!['second-app' as UiGraphId] = {
    components: [],
    id: 'second-app' as UiGraphId,
    name: 'Second web app',
  };
  await writeFile(projectFile, serializeProject(project) as string, 'utf8');

  const response = await app.fetch(new Request('http://localhost/app.json'));
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { name: string }).name, 'Changed web app');
});

test('createWebAppServeApp dev mode reports project reload failures as server errors', async (t) => {
  const projectFile = await writeTemporaryProject(t, createProjectWithWebApp());
  const { app } = await createWebAppServeApp({
    ...buildServeAppArgs(),
    dev: true,
    projectFile,
  });

  await writeFile(projectFile, 'not: [valid', 'utf8');

  const response = await app.fetch(new Request('http://localhost/app.json'));
  assert.equal(response.status, 500);
  assert.equal(response.headers.has('x-duration-ms'), true);
});

test('createWebAppServeApp rejects the health endpoint as a base path', async (t) => {
  const projectFile = await writeTemporaryProject(t, createProjectWithWebApp());

  for (const basePath of ['healthz', '/healthz', '/healthz/']) {
    await assert.rejects(
      () =>
        createWebAppServeApp({
          ...buildServeAppArgs(),
          basePath,
          projectFile,
        }),
      /reserved/,
    );
  }
});

test('buildProjectInspection summarizes graphs, web apps, node library items, and plugins', () => {
  const project = createProjectWithWebApp();
  project.plugins = ['openai'];
  project.nodePrefabs = {
    prefab: {
      id: 'prefab' as NodePrefabId,
      sourceNode: {
        data: {
          normalizeLineEndings: true,
          text: 'hello',
        },
        id: 'prefab-node' as NodeId,
        title: 'Reusable text',
        type: 'text',
        visualData: {
          x: 0,
          y: 0,
          width: 300,
        },
      },
    },
  };

  assert.deepEqual(buildProjectInspection(project, 'project.rivet-project'), {
    graphs: [
      {
        id: 'main',
        main: true,
        name: 'Main',
        nodes: 2,
      },
    ],
    libraryNodes: [
      {
        id: 'prefab',
        nodeType: 'text',
        title: 'Reusable text',
      },
    ],
    path: 'project.rivet-project',
    plugins: ['openai'],
    project: {
      description: '',
      id: 'project',
      mainGraphId: 'main',
      title: 'Test project',
    },
    webApps: [
      {
        components: 1,
        id: 'app',
        name: 'Test web app',
      },
    ],
  });
});

test('buildDoctorReport reports healthy projects and missing required dataset files', async (t) => {
  const projectFile = await writeTemporaryProject(t, createProjectWithWebApp());

  const healthyReport = await buildDoctorReport(projectFile);
  assert.equal(healthyReport.ok, true);
  assert.equal(healthyReport.summary.errors, 0);
  assert.equal(healthyReport.checks.find((check) => check.id === 'main-graph')?.status, 'ok');

  const missingDatasetReport = await buildDoctorReport(projectFile, { requireDatasetFile: true });
  assert.equal(missingDatasetReport.ok, false);
  assert.equal(missingDatasetReport.checks.find((check) => check.id === 'dataset-file')?.status, 'error');
});

test('buildDoctorReport reports stale main graph references', async (t) => {
  const project = createProjectWithWebApp();
  project.metadata.mainGraphId = 'missing' as GraphId;
  const projectFile = await writeTemporaryProject(t, project);

  const report = await buildDoctorReport(projectFile);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.id === 'main-graph')?.status, 'error');
});

function buildServeArgs(): ServeArgs {
  return {
    allowSpecifyingGraphId: false,
    corsOrigin: [],
    dev: false,
    endpoint: [],
    exposeCost: false,
    graph: undefined,
    host: '0.0.0.0',
    openaiApiKey: undefined,
    openaiEndpoint: undefined,
    openaiOrganization: undefined,
    port: 3000,
    projectFile: 'cli-example.rivet-project',
    stream: undefined,
    streamNode: undefined,
    unwrapOutput: undefined,
  };
}

function buildServeAppArgs(): ServeAppArgs {
  return {
    basePath: '/',
    corsOrigin: [],
    dev: false,
    host: '0.0.0.0',
    port: 3000,
    projectFile: '',
    revisionKey: undefined,
    uiGraph: undefined,
  };
}

function buildRunArgs() {
  return {
    context: [],
    contextFile: undefined,
    contextJson: [],
    datasetFile: undefined,
    graphName: undefined,
    includeCost: false,
    input: [],
    inputJson: [],
    inputsFile: undefined,
    inputsStdin: false,
    outputFile: undefined,
    outputKey: undefined,
    projectFile: '',
    requireDatasetFile: false,
    saveDatasets: false,
    unwrapOutput: undefined,
  };
}

function createProjectWithWebApp(): Project {
  const graphId = 'main' as GraphId;
  const uiGraphId = 'app' as UiGraphId;
  const inputNodeId = 'input-node' as NodeId;
  const outputNodeId = 'output-node' as NodeId;
  const inputNode: ChartNode<'graphInput'> = {
    data: {
      dataType: 'string',
      id: 'input',
      useDefaultValueInput: false,
    },
    id: inputNodeId,
    title: 'Graph Input',
    type: 'graphInput',
    visualData: { x: 0, y: 0, width: 300 },
  };
  const outputNode: ChartNode<'graphOutput'> = {
    data: {
      dataType: 'string',
      id: 'answer',
    },
    id: outputNodeId,
    title: 'Graph Output',
    type: 'graphOutput',
    visualData: { x: 400, y: 0, width: 300 },
  };

  return {
    graphs: {
      [graphId]: {
        connections: [
          {
            inputId: 'value' as PortId,
            inputNodeId: outputNodeId,
            outputId: 'data' as PortId,
            outputNodeId: inputNodeId,
          },
        ],
        metadata: {
          description: '',
          id: graphId,
          name: 'Main',
        },
        nodes: [inputNode, outputNode],
      },
    },
    metadata: {
      description: '',
      id: 'project' as ProjectId,
      mainGraphId: graphId,
      title: 'Test project',
    },
    plugins: [],
    uiGraphs: {
      [uiGraphId]: {
        components: [
          {
            action: {
              graphId,
              inputMappings: [{ inputKey: 'input', stateKey: 'prompt' }],
              outputs: [{ outputKey: 'answer', stateKey: 'result' }],
              type: 'runGraph',
            },
            id: 'button' as UiComponentId,
            label: 'Run',
            type: 'button',
          },
        ],
        id: uiGraphId,
        name: 'Test web app',
      },
    },
  };
}

function createDatasetAppendProject(): Project {
  const graphId = 'append-graph' as GraphId;
  const inputNodeId = 'input-node' as NodeId;
  const textNodeId = 'dataset-id-node' as NodeId;
  const createDatasetNodeId = 'create-dataset-node' as NodeId;
  const appendNodeId = 'append-node' as NodeId;
  const outputNodeId = 'output-node' as NodeId;
  const inputNode: ChartNode<'graphInput'> = {
    data: {
      dataType: 'string[]',
      id: 'data',
      useDefaultValueInput: false,
    },
    id: inputNodeId,
    title: 'Graph Input',
    type: 'graphInput',
    visualData: { x: 0, y: 0, width: 300 },
  };
  const appendNode: ChartNode<'appendToDataset'> = {
    data: {
      datasetId: 'dataset',
      useDatasetIdInput: true,
    },
    id: appendNodeId,
    title: 'Append to Dataset',
    type: 'appendToDataset',
    visualData: { x: 400, y: 0, width: 300 },
  };
  const textNode: ChartNode<'text'> = {
    data: {
      normalizeLineEndings: true,
      text: 'dataset',
    },
    id: textNodeId,
    title: 'Text',
    type: 'text',
    visualData: { x: 0, y: 200, width: 300 },
  };
  const createDatasetNode: ChartNode<'createDataset'> = {
    data: {},
    id: createDatasetNodeId,
    title: 'Create Dataset',
    type: 'createDataset',
    visualData: { x: 400, y: 200, width: 300 },
  };
  const outputNode: ChartNode<'graphOutput'> = {
    data: {
      dataType: 'string',
      id: 'datasetId',
    },
    id: outputNodeId,
    title: 'Graph Output',
    type: 'graphOutput',
    visualData: { x: 800, y: 0, width: 300 },
  };

  return {
    graphs: {
      [graphId]: {
        connections: [
          {
            inputId: 'data' as PortId,
            inputNodeId: appendNodeId,
            outputId: 'data' as PortId,
            outputNodeId: inputNodeId,
          },
          {
            inputId: 'datasetId' as PortId,
            inputNodeId: createDatasetNodeId,
            outputId: 'output' as PortId,
            outputNodeId: textNodeId,
          },
          {
            inputId: 'datasetId' as PortId,
            inputNodeId: appendNodeId,
            outputId: 'datasetId_out' as PortId,
            outputNodeId: createDatasetNodeId,
          },
          {
            inputId: 'value' as PortId,
            inputNodeId: outputNodeId,
            outputId: 'id_out' as PortId,
            outputNodeId: appendNodeId,
          },
        ],
        metadata: {
          description: '',
          id: graphId,
          name: 'Append',
        },
        nodes: [inputNode, textNode, createDatasetNode, appendNode, outputNode],
      },
    },
    metadata: {
      description: '',
      id: 'dataset-project' as ProjectId,
      mainGraphId: graphId,
      title: 'Dataset test project',
    },
    plugins: [],
  };
}

async function writeTemporaryProject(t: test.TestContext, project: Project): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rivet-cli-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));

  const projectFile = join(directory, 'project.rivet-project');
  await writeFile(projectFile, serializeProject(project) as string, 'utf8');
  return projectFile;
}
