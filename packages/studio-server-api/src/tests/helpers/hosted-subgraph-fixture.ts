import {
  DelayNodeImpl,
  getGraphBoundary,
  serializeProject,
  type GraphId,
  type NodeId,
  type ProjectId,
  type PortId,
  type SubGraphNode,
  type TextNode,
} from '@valerypopoff/rivet2-node';
import * as storage from '../../routes/workflows/storage-backend.js';
import { projectBundleFixture } from './project-bundle-fixture.js';
import { remapBundleProject } from '../../routes/workflows/remap-bundle-project.js';

/** Pure, test-owned projects: two different graphs of one explicit bundle sibling. */
export async function seedHostedSubgraphFixture() {
  const bundles = await storage.getExplicitBundleService();
  const bundle = await bundles.create('Hosted Subgraph fixture', '');
  const foreign = await bundles.create('Foreign fixture', '');
  const caller = await storage.createWorkflowProjectItemWithBackend(bundle.relativePath, 'Hosted caller');
  const target = await storage.createWorkflowProjectItemWithBackend(bundle.relativePath, 'Hosted target');
  const fixture = projectBundleFixture();
  const ids = new Map([
    ['bundle-root', caller.projectMetadataId! as ProjectId],
    ['bundle-child', target.projectMetadataId! as ProjectId],
  ]);
  const root = fixture.root.project;
  const child = fixture.child.project;
  remapBundleProject(root, ids);
  remapBundleProject(child, ids);
  // Keep a real child run in flight long enough to close/reopen its editor tab.
  const childMain = child.graphs['child-main' as GraphId]!;
  const childDelay = DelayNodeImpl.create();
  childDelay.id = 'bundle-child-delay' as NodeId;
  childDelay.data.delay = 5000;
  const connection = childMain.connections[0]!;
  childMain.nodes.push(childDelay);
  childMain.connections = [
    { ...connection, inputNodeId: childDelay.id, inputId: 'input1' as PortId },
    {
      outputNodeId: childDelay.id,
      outputId: 'output1' as PortId,
      inputNodeId: connection.inputNodeId,
      inputId: connection.inputId,
    },
  ];
  const secondGraph = structuredClone(child.graphs['child-main' as GraphId]!);
  secondGraph.metadata = { ...secondGraph.metadata, id: 'child-second' as GraphId, name: 'Second child' };
  (secondGraph.nodes.find((node) => node.type === 'text')! as TextNode).data.text = 'second-child-result';
  child.graphs['child-second' as GraphId] = secondGraph;
  const graph = root.graphs['main' as GraphId]!;
  const first = graph.nodes.find((node) => node.type === 'subGraph')! as SubGraphNode;
  first.id = 'bundle-call-one' as NodeId;
  first.title = 'First sibling call';
  const second = structuredClone(first);
  second.id = 'bundle-call-two' as NodeId;
  second.title = 'Second sibling call';
  second.data.graphId = 'child-second' as GraphId;
  second.data.targetBoundary = getGraphBoundary(child, 'child-second' as GraphId)!;
  const output = graph.nodes.find((node) => node.type === 'graphOutput')!;
  output.id = 'bundle-result' as NodeId;
  const delay = DelayNodeImpl.create();
  delay.id = 'bundle-display-delay' as NodeId;
  delay.data.delay = 5000;
  graph.nodes = [first, second, delay, output];
  graph.nodes.forEach((node, index) => {
    node.visualData = { x: 100 + index * 360, y: 180, width: 260 };
  });
  graph.connections = [
    { outputNodeId: first.id, outputId: 'result' as PortId, inputNodeId: delay.id, inputId: 'input1' as PortId },
    { outputNodeId: delay.id, outputId: 'output1' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
  ];
  const unpublishedCall = structuredClone(first);
  unpublishedCall.id = 'unpublished-call' as NodeId;
  unpublishedCall.data.targetVersion = 'published';
  root.graphs['published-target' as GraphId] = {
    metadata: { id: 'published-target' as GraphId, name: 'Published target' },
    nodes: [unpublishedCall],
    connections: [],
  };
  for (const [item, project] of [
    [caller, root],
    [target, child],
  ] as const) {
    const saved = await storage.loadHostedProject(item.absolutePath);
    await storage.saveHostedProject({
      projectPath: item.absolutePath,
      projectId: item.projectMetadataId as ProjectId,
      contents: serializeProject(project) as string,
      datasetsContents: null,
      expectedRevisionId: saved.revisionId,
    });
  }
  return {
    caller,
    target,
    project: root,
    foreignPath: foreign.relativePath,
    childOutputId: child.graphs['child-main' as GraphId]!.nodes.find((node) => node.type === 'graphOutput')!.id,
  };
}
