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
  type PortId,
  type Project,
  type ProjectId,
  type UiComponentId,
  type UiGraphId,
} from '@valerypopoff/rivet2-node';
import yargs from 'yargs';
import { parseJsonInputRecord, parseJsonKeyValueInputRecord, parseKeyValueInputRecord } from '../src/commandInputs.js';
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
import { throwIfInvalidGraph, throwIfNoMainGraph } from '../src/cliRuntime.js';
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

test('serve-app command exposes its expected defaults', () => {
  const command = makeServeAppCommand(yargs([])).exitProcess(false);
  const options = command.getOptions();

  assert.equal(options.default.port, 3000);
  assert.equal(options.default.host, '0.0.0.0');
  assert.equal(options.default['base-path'], '/');
  assert.deepEqual(options.default['cors-origin'], []);
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
    openaiApiKey: 'key',
    openaiEndpoint: undefined,
    openaiOrganization: undefined,
  });

  assert.equal('runtimeProfile' in options, false);
  assert.equal(options.graph, 'Main');
  assert.deepEqual(options.inputs, { input: 'value' });
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
});

test('parseEndpointAliases validates aliases and duplicate endpoint names', async () => {
  const { loadProjectFromFile } = await import('@valerypopoff/rivet2-node');
  const project = await loadProjectFromFile(resolve('cli-example.rivet-project'));

  assert.deepEqual([...parseEndpointAliases(['pass=Passthrough'], project)], [['pass', 'Passthrough']]);
  assert.throws(() => parseEndpointAliases(['pass=Passthrough', 'pass=Passthrough Context'], project), /Duplicate/);
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
  assert.match(await staleActionResponse.text(), /revision mismatch/);
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

  return {
    graphs: {
      [graphId]: {
        connections: [],
        metadata: {
          description: '',
          id: graphId,
          name: 'Main',
        },
        nodes: [],
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
