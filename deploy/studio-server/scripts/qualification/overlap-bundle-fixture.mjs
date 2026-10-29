import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { rootStructuralMutation } from '../lib/structural-fixture-admission.mjs';

/** New, synthetic bundle only. Each modifying request is sent once. The outer
 * provider phase already journals intent; an uncertain response ends the phase. */
export async function prepareOverlapBundle(gate, template) {
  const request = (route, body, headers = {}) =>
    gate.requestWorkflow(gate.config.baseUrl, route, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  const { folder } = await request(
    '/api/workflows/folders',
    {
      name: `handover-${randomUUID()}`,
      mutation: rootStructuralMutation(),
    },
    { 'X-Rivet-Namespace-Intent': '1' },
  );
  assert.ok(folder.namespaceId);
  const project = (title) => {
    const value = parse(template);
    value.data.metadata.id = randomUUID();
    value.data.metadata.title = title;
    delete value.data.uiGraphs;
    const graph = value.data.graphs[value.data.metadata.mainGraphId];
    graph.nodes = {
      '[input]:graphInput "Input"': {
        data: { id: 'input', dataType: 'string' },
        outgoingConnections: ['data->"Delay" delay/input1'],
        visualData: '0/0/300/null//',
      },
      '[delay]:delay "Delay"': {
        data: { delay: 1500, useDelayInput: false },
        outgoingConnections: ['output1->"Output" output/value'],
        visualData: '300/0/300/null//',
      },
      '[output]:graphOutput "Output"': { data: { id: 'output', dataType: 'string' }, visualData: '600/0/300/null//' },
    };
    return value;
  };
  const upload = async (value, name) => {
    const { project: saved } = await request(
      '/api/workflows/projects/upload',
      {
        folderRelativePath: folder.relativePath,
        fileName: `${name}.rivet-project`,
        contents: stringify(value),
        mutation: { ...rootStructuralMutation(), expectedDestinationId: folder.namespaceId },
      },
      { 'X-Rivet-Namespace-Intent': '1' },
    );
    assert.ok(saved.id);
    return saved;
  };
  const child = project('Handover child'),
    savedChild = await upload(child, 'child');
  const root = project('Handover root'),
    graph = root.data.graphs[root.data.metadata.mainGraphId];
  delete graph.nodes['[delay]:delay "Delay"'];
  graph.nodes['[input]:graphInput "Input"'].outgoingConnections = ['data->"Child" child/input'];
  graph.nodes['[child]:subGraph "Child"'] = {
    data: {
      graphId: child.data.metadata.mainGraphId,
      targetProjectId: savedChild.id,
      targetScope: 'same-bundle',
      targetVersion: 'latest',
    },
    outgoingConnections: ['output->"Output" output/value'],
    visualData: '300/0/300/null//',
  };
  const savedRoot = await upload(root, 'root');
  const converted = await request(
    '/api/workflows/bundles/kind',
    {
      relativePath: folder.relativePath,
      namespaceId: folder.namespaceId,
      enabled: true,
      mutation: { ...rootStructuralMutation(), expectedSource: { id: folder.namespaceId } },
    },
    { 'X-Rivet-Bundle-Intent': '1' },
  );
  assert.ok(converted.folder.bundleId);
  const snapshot = await gate.requestWorkflow(
    gate.config.baseUrl,
    `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(savedRoot.relativePath)}`,
  );
  const endpoint = `handover-${randomUUID()}`;
  await request('/api/workflows/projects/publish', {
    relativePath: savedRoot.relativePath,
    settings: { endpointName: endpoint },
    preconditions: {
      expectedProjectId: snapshot.projectId,
      expectedDraftRevisionId: snapshot.draftRevisionId,
      expectedPublicationVersion: snapshot.publicationVersion,
    },
  });
  return { endpoint, projectIds: [savedRoot.id, savedChild.id], bundleId: converted.folder.bundleId };
}
