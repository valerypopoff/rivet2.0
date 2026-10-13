import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBuiltInRegistry,
  GraphInputNodeImpl,
  type DataId,
  type GraphId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import type { EvaluationDataset, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import { captureEditorRun, evaluationInputsToGraphOutputs, prepareEvaluationRun } from './preparedEditorRun.js';

const graphId = 'main' as GraphId;
const project: Project = {
  metadata: { id: 'project' as ProjectId, title: 'Project', description: '', mainGraphId: graphId },
  graphs: { [graphId]: { metadata: { id: graphId, name: 'Main' }, nodes: [], connections: [] } },
};
const registry = createBuiltInRegistry();
const dataId = 'value' as DataId;

test('Evaluation input preparation uses the target input types and rejects unknown inputs', () => {
  const source = structuredClone(project);
  const node = GraphInputNodeImpl.create();
  node.data.id = 'count';
  node.data.dataType = 'number';
  source.graphs[graphId]!.nodes.push(node);
  assert.deepEqual(evaluationInputsToGraphOutputs(source, graphId, { count: 3 }), {
    count: { type: 'number', value: 3 },
  });
  assert.throws(() => evaluationInputsToGraphOutputs(source, graphId, { unknown: 3 }), /unknown graph input/);
  assert.throws(() => evaluationInputsToGraphOutputs(source, 'missing' as GraphId, {}), /does not exist/);
});

test('editor preparation captures authored graph/static data and inputs without cloning host callbacks', () => {
  const source = structuredClone(project);
  const inputs = { value: { type: 'string' as const, value: 'original' } };
  const callback = () => {};
  const captured = captureEditorRun({
    project: source,
    currentGraph: source.graphs[graphId]!,
    projectData: { [dataId]: 'static' },
    plugins: { appPluginStates: [], registry },
    options: { inputs, onProgress: callback },
  });
  source.graphs[graphId]!.metadata!.name = 'edited';
  inputs.value.value = 'edited';
  assert.equal(captured.project.graphs[graphId]!.metadata!.name, 'Main');
  assert.equal(captured.options.inputs!.value!.value, 'original');
  assert.equal(captured.project.data![dataId], 'static');
  assert.equal(captured.options.onProgress, callback);
});

test('both Evaluation adapters resolve the explicit suite graph and reject missing resources', () => {
  const suite = { id: 'suite', datasetId: 'dataset', targetGraphId: graphId } as EvaluationSuite;
  const dataset = { id: 'dataset' } as EvaluationDataset;
  const input = {
    project,
    suiteId: suite.id,
    suites: [suite],
    datasets: [dataset],
    plugins: { appPluginStates: [], registry },
  };
  const prepared = prepareEvaluationRun(input);
  assert.equal(prepared.suite, suite);
  assert.equal(prepared.dataset, dataset);
  assert.throws(() => prepareEvaluationRun({ ...input, datasets: [] }), /no longer exists/);
  assert.throws(
    () => prepareEvaluationRun({ ...input, suites: [{ ...suite, targetGraphId: 'missing' as GraphId }] }),
    /target graph/,
  );
});
