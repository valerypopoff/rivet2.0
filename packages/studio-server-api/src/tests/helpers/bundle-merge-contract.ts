import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createProcessor,
  loadProjectAndAttachedDataFromString,
  serializeProject,
  serializeDatasets,
  deserializeDatasets,
  getGraphBoundary,
  type Project,
  type ProjectId,
  type DatasetId,
  type SubGraphNode,
  type GraphId,
} from '@valerypopoff/rivet2-node';
import type { ManagedWorkflowBackend } from '../../routes/workflows/managed/backend.js';
import type { WorkflowProjectItem } from '../../../../studio-server-shared/workflow-types.js';
import type { BundleMergeChoices, BundleMergeCommit } from '../../../../studio-server-shared/workflow-bundle-types.js';
import { lockBundleTopology } from '../../routes/workflows/managed/topology-lock.js';
import { remapBundleProject, inspectBundleProjectBindings } from '../../routes/workflows/remap-bundle-project.js';
import { projectBundleFixture } from './project-bundle-fixture.js';

/** Runs only against the owning integration's disposable PostgreSQL/MinIO services. */
export async function verifyBundleMergeContract(
  backend: ManagedWorkflowBackend,
  pool: Pool,
  http: { baseUrl: string; headers: Record<string, string> },
) {
  const original = await backend.bundles.create(`Merge A ${randomUUID()}`, '');
  const a = await backend.createWorkflowProjectItem(original.relativePath, 'A');
  const b = await backend.createWorkflowProjectItem(original.relativePath, 'B');
  const x = await backend.createWorkflowProjectItem(original.relativePath, 'X');
  const unrelated = await backend.createWorkflowProjectItem(original.relativePath, 'Unrelated');
  const fixture = projectBundleFixture();
  const save = async (item: WorkflowProjectItem, project: Project, datasetsContents: string | null = null) => {
    const loaded = await backend.loadHostedProject(item.absolutePath);
    project.metadata.title = item.name;
    return backend.saveHostedProject({
      projectPath: item.absolutePath,
      projectId: item.projectMetadataId,
      expectedRevisionId: loaded.revisionId,
      saveIntent: 'in-place',
      contents: serializeProject(project) as string,
      datasetsContents,
    });
  };
  const datasets = (id: string, datasetId: string) =>
    serializeDatasets([
      {
        meta: { id: datasetId as DatasetId, projectId: id as ProjectId, name: 'Rows', description: '' },
        data: { id: datasetId as DatasetId, rows: [{ id: 'row', data: [datasetId] }] },
      },
    ]);
  for (const item of [a, b]) {
    const project = structuredClone(fixture.root.project);
    remapBundleProject(
      project,
      new Map([
        ['bundle-root', item.projectMetadataId! as ProjectId],
        ['bundle-child', x.projectMetadataId! as ProjectId],
      ]),
    );
    await save(item, project, datasets(item.projectMetadataId!, 'old-data'));
  }
  const child = structuredClone(fixture.child.project);
  remapBundleProject(child, new Map([['bundle-child', x.projectMetadataId! as ProjectId]]));
  await save(x, child);
  const publication = await backend.listWorkflowProjectWebApps(a.relativePath);
  await backend.publishWorkflowProjectItem(
    a.relativePath,
    { endpointName: `merge-${randomUUID()}` },
    {
      expectedProjectId: publication.projectId,
      expectedPublicationVersion: publication.publicationVersion,
      expectedDraftRevisionId: publication.draftRevisionId,
    },
  );
  const published = (
    await pool.query(
      'SELECT published_revision_id,published_version_id,endpoint_name,published_endpoint_name FROM workflows WHERE workflow_id=$1',
      [a.projectMetadataId],
    )
  ).rows[0];
  const copy = await backend.bundles.duplicate(original.bundleId!, { automatic: true });
  const tree = await backend.getTree();
  const copied = tree.folders.find((folder) => folder.bundleId === copy.bundleId)!;
  const a1 = copied.projects.find((item) => item.name === 'A')!;
  const b1 = copied.projects.find((item) => item.name === 'B')!;
  const x1 = copied.projects.find((item) => item.name === 'X')!;
  const c1 = await backend.createWorkflowProjectItem(copied.relativePath, 'C');
  const added = structuredClone(fixture.child.project);
  remapBundleProject(added, new Map([['bundle-child', c1.projectMetadataId! as ProjectId]]));
  const text = Object.values(added.graphs)[0]!.nodes.find((node) => node.type === 'text')!;
  (text.data as { text: string }).text = 'merged-new-project';
  await save(c1, added);
  const forkOnly = loadProjectAndAttachedDataFromString((await backend.loadHostedProject(x1.absolutePath)).contents)[0];
  (Object.values(forkOnly.graphs)[0]!.nodes.find((node) => node.type === 'text')!.data as { text: string }).text =
    'must-not-import';
  await save(x1, forkOnly);
  const nextA = loadProjectAndAttachedDataFromString((await backend.loadHostedProject(a1.absolutePath)).contents)[0];
  const call = Object.values(nextA.graphs)[0]!.nodes.find((node) => node.type === 'subGraph') as SubGraphNode;
  call.data.targetProjectId = c1.projectMetadataId as ProjectId;
  call.data.targetBoundary = getGraphBoundary(added, call.data.graphId)!;
  await save(a1, nextA, datasets(a1.projectMetadataId!, 'new-data'));
  const choices: BundleMergeChoices = {
    destinationBundleId: original.bundleId!,
    actions: [
      { sourceProjectId: a1.projectMetadataId!, kind: 'replace', targetProjectId: a.projectMetadataId! },
      { sourceProjectId: b1.projectMetadataId!, kind: 'replace', targetProjectId: b.projectMetadataId! },
      { sourceProjectId: c1.projectMetadataId!, kind: 'add', relativePath: 'Nested/Added.rivet-project' },
    ],
    dependencies: [],
    graphs: [],
  };
  const partial = await backend.bundles.mergePreview(copy.bundleId, choices);
  assert.deepEqual(
    partial.requiredProjects.map((value) => value.project.projectId),
    [x1.projectMetadataId],
  );
  assert.equal(partial.fingerprint, undefined);
  choices.dependencies.push({
    sourceProjectId: x1.projectMetadataId!,
    kind: 'existing',
    targetProjectId: x.projectMetadataId!,
  });
  // Inactive configurations retain their mapping without turning graph warnings into blockers.
  const originalB = loadProjectAndAttachedDataFromString(
    (await backend.loadHostedProject(b1.absolutePath)).contents,
  )[0];
  const variantB = structuredClone(originalB);
  const variantCall = Object.values(variantB.graphs)[0]!.nodes.find((node) => node.type === 'subGraph') as SubGraphNode;
  variantCall.variants = [
    { id: 'inactive-contract', data: { ...variantCall.data, graphId: 'missing-inactive-graph' } },
  ];
  await save(b1, variantB);
  const inactiveReview = await backend.bundles.mergePreview(copy.bundleId, choices);
  assert.ok(inactiveReview.fingerprint);
  assert.deepEqual(inactiveReview.requiredGraphs, []);
  assert.ok(inactiveReview.warnings.some((warning) => warning.site?.variantIndex === 0));
  await save(b1, originalB);

  // A different graph identity needs an explicit, wire-compatible correspondence.
  const counterpartItem = await backend.createWorkflowProjectItem(original.relativePath, 'Different graph');
  const counterpart = structuredClone(child);
  remapBundleProject(counterpart, new Map([[x.projectMetadataId!, counterpartItem.projectMetadataId! as ProjectId]]));
  const counterpartGraph = Object.values(counterpart.graphs)[0]!;
  counterpartGraph.metadata!.id = 'other-child' as GraphId;
  counterpart.graphs = { ['other-child' as GraphId]: counterpartGraph };
  counterpart.metadata.mainGraphId = 'other-child' as GraphId;
  await save(counterpartItem, counterpart);
  const graphChoices: BundleMergeChoices = {
    ...choices,
    dependencies: [
      { sourceProjectId: x1.projectMetadataId!, kind: 'existing', targetProjectId: counterpartItem.projectMetadataId! },
    ],
  };
  const graphReview = await backend.bundles.mergePreview(copy.bundleId, graphChoices);
  assert.equal(graphReview.requiredGraphs.length, 1);
  assert.equal(graphReview.fingerprint, undefined);
  graphChoices.graphs = [
    { sourceProjectId: x1.projectMetadataId!, sourceGraphId: 'child-main', targetGraphId: 'other-child' },
  ];
  const mappedReview = await backend.bundles.mergePreview(copy.bundleId, graphChoices);
  assert.ok(mappedReview.fingerprint);
  assert.equal(mappedReview.requiredGraphs.length, 0);
  assert.equal(mappedReview.mappedGraphs?.length, 1);
  assert.equal(mappedReview.mappedGraphs?.[0]?.sourceGraphName, 'Child');
  assert.equal(mappedReview.mappedGraphs?.[0]?.selectedGraphId, 'other-child');
  assert.deepEqual(mappedReview.mappedGraphs?.[0]?.options, [{ id: 'other-child', name: 'Child' }]);
  const reviewed = await backend.bundles.mergePreview(copy.bundleId, choices);
  assert.deepEqual(reviewed.blockers, []);
  assert.ok(reviewed.fingerprint);
  const sourceBefore = await Promise.all([a1, b1, x1, c1].map((item) => backend.loadHostedProject(item.absolutePath)));
  const guard = () => ({
    operationId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    expectedSource: { id: copied.namespaceId! },
    expectedDestinationId: original.namespaceId!,
  });
  const request: BundleMergeCommit = {
    choices,
    fingerprint: reviewed.fingerprint!,
    acknowledgedWarnings: reviewed.warnings.map((value) => value.id),
  };
  const headers = { ...http.headers, 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' };
  const url = `${http.baseUrl}/api/workflows/bundles/${copy.bundleId}/merge`;
  const denied = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(denied.status, 428, await denied.text());
  const crossSite = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ ...request, mutation: guard() }),
  });
  assert.equal(crossSite.status, 403, await crossSite.text());

  // Force failure after an earlier destination pointer has changed inside the transaction.
  const before = (
    await pool.query(
      'SELECT workflow_id,current_draft_revision_id FROM workflows WHERE workflow_id=ANY($1::text[]) ORDER BY workflow_id',
      [[a.projectMetadataId, b.projectMetadataId]],
    )
  ).rows;
  const trigger = `merge_fail_${randomUUID().replaceAll('-', '')}`;
  await pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.workflow_id='${b.projectMetadataId}' THEN RAISE EXCEPTION 'test merge second-row failure'; END IF; RETURN NEW; END $$`,
  );
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  const failedGuard = guard();
  try {
    await assert.rejects(backend.bundles.merge(copy.bundleId, request, failedGuard), /test merge second-row failure/);
  } finally {
    await pool.query(`DROP TRIGGER ${trigger} ON workflows`);
    await pool.query(`DROP FUNCTION ${trigger}()`);
  }
  assert.deepEqual(
    (
      await pool.query(
        'SELECT workflow_id,current_draft_revision_id FROM workflows WHERE workflow_id=ANY($1::text[]) ORDER BY workflow_id',
        [[a.projectMetadataId, b.projectMetadataId]],
      )
    ).rows,
    before,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM workflows WHERE relative_path=$1', [
        `${original.relativePath}/Nested/Added.rivet-project`,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM workflow_namespace_receipts WHERE operation_id=$1', [failedGuard.operationId]))
      .rowCount,
    0,
  );

  // A save of unrelated content must not invalidate this review.
  const unrelatedProject = loadProjectAndAttachedDataFromString(
    (await backend.loadHostedProject(unrelated.absolutePath)).contents,
  )[0];
  unrelatedProject.metadata.description = 'unrelated edit';
  await save(unrelated, unrelatedProject);
  assert.equal(
    (await backend.bundles.mergePreview(copy.bundleId, choices)).fingerprint,
    reviewed.fingerprint,
    'An unrelated draft edit does not invalidate the reviewed read set',
  );
  const admission = guard();
  const receiptBlocker = await pool.connect();
  await receiptBlocker.query('BEGIN');
  await lockBundleTopology(receiptBlocker);
  const receiptBlockerPid = (await receiptBlocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const concurrent = Promise.allSettled([
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, mutation: admission }),
      signal: AbortSignal.timeout(30_000),
    }),
    backend.bundles.merge(copy.bundleId, request, admission),
  ] as const);
  try {
    const deadline = Date.now() + 3000;
    for (;;) {
      const waiting = await pool.query(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
        [receiptBlockerPid],
      );
      if (waiting.rows[0].count >= 2) break;
      if (Date.now() >= deadline) throw new Error('Concurrent merges did not both reach the topology lease.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await receiptBlocker.query('ROLLBACK');
    receiptBlocker.release();
  }
  const [firstResult, secondResult] = await concurrent;
  if (firstResult.status === 'rejected') throw firstResult.reason;
  if (secondResult.status === 'rejected') throw secondResult.reason;
  const response = firstResult.value;
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as Awaited<ReturnType<typeof backend.bundles.merge>>;
  assert.deepEqual(secondResult.value, result, 'Concurrent identical admissions return one exact committed result');
  assert.deepEqual(result.warnings, reviewed.warnings);
  assert.equal(result.projects.length, 3);
  assert.equal(result.projectMapping[a1.projectMetadataId!], a.projectMetadataId);
  assert.equal(result.projectMapping[b1.projectMetadataId!], b.projectMetadataId);
  const newId = result.projectMapping[c1.projectMetadataId!]!;
  assert.notEqual(newId, c1.projectMetadataId);
  assert.equal(result.projectMapping[x1.projectMetadataId!], x.projectMetadataId);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT published_revision_id,published_version_id,endpoint_name,published_endpoint_name FROM workflows WHERE workflow_id=$1',
        [a.projectMetadataId],
      )
    ).rows[0],
    published,
  );
  assert.deepEqual(
    await Promise.all([a1, b1, x1, c1].map((item) => backend.loadHostedProject(item.absolutePath))),
    sourceBefore,
  );
  for (const [item, expected] of [
    [a, 'merged-new-project'],
    [b, 'child-result'],
  ] as const) {
    const saved = await backend.loadHostedProject(item.absolutePath);
    const definition = loadProjectAndAttachedDataFromString(saved.contents)[0];
    assert.equal(definition.metadata.id, item.projectMetadataId);
    assert.equal(definition.metadata.title, item.name);
    assert.ok(
      !inspectBundleProjectBindings(definition).some((binding) =>
        copied.projects.some((member) => member.projectMetadataId === binding.projectId),
      ),
    );
    const processor = createProcessor(definition, {
      subgraphProjectLoader: { loadTarget: (target) => backend.loadSubgraphTarget(target) },
    });
    try {
      assert.equal((await processor.run())['result']?.value, expected);
    } finally {
      processor.dispose();
    }
  }
  const mergedData = deserializeDatasets((await backend.loadHostedProject(a.absolutePath)).datasetsContents!);
  assert.deepEqual(
    mergedData.map((value) => value.meta.id),
    ['new-data'],
  );
  assert.equal(mergedData[0]!.meta.projectId, a.projectMetadataId);
  assert.equal(
    (await backend.loadHostedProject(b.absolutePath)).datasetsContents,
    null,
    'Replacing with no sidecar removes the destination draft datasets',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM workflows w JOIN workflow_revisions r ON r.revision_id=w.current_draft_revision_id WHERE w.workflow_id=ANY($1::text[]) AND r.reference_summary->>'projectId'=w.workflow_id",
        [result.projects.map((value) => value.projectId)],
      )
    ).rows[0].count,
    3,
  );
  // Replaying an acknowledged command returns exactly its result, including the new ID.
  assert.deepEqual(await backend.bundles.merge(copy.bundleId, request, admission), result);
  await assert.rejects(
    backend.bundles.merge(copy.bundleId, { ...request, fingerprint: '0'.repeat(64) }, admission),
    /different request/,
  );
  await assert.rejects(backend.bundles.merge(copy.bundleId, request, guard()), /review changed|already exists/);

  // Active published snapshots matter even when their project's draft is also replaced.
  const breaking = structuredClone(forkOnly);
  breaking.graphs = {};
  await save(x1, breaking);
  const warningReview = await backend.bundles.mergePreview(copy.bundleId, {
    destinationBundleId: original.bundleId!,
    actions: [{ kind: 'replace', sourceProjectId: x1.projectMetadataId!, targetProjectId: x.projectMetadataId! }],
    dependencies: [],
    graphs: [],
  });
  assert.ok(warningReview.fingerprint, 'Breaking incoming calls are reviewable warnings, not a whole-bundle gate');
  assert.ok(
    warningReview.warnings.some(
      (warning) => warning.message.includes('published-endpoint') && warning.site?.projectId === a.projectMetadataId,
    ),
  );
  await assert.rejects(
    backend.bundles.merge(
      copy.bundleId,
      {
        choices: {
          destinationBundleId: original.bundleId!,
          actions: [{ kind: 'replace', sourceProjectId: x1.projectMetadataId!, targetProjectId: x.projectMetadataId! }],
          dependencies: [],
          graphs: [],
        },
        fingerprint: warningReview.fingerprint!,
        acknowledgedWarnings: [],
      },
      guard(),
    ),
    /Acknowledge the current merge warnings/,
  );
  const warned = await backend.bundles.merge(
    copy.bundleId,
    {
      choices: {
        destinationBundleId: original.bundleId!,
        actions: [{ kind: 'replace', sourceProjectId: x1.projectMetadataId!, targetProjectId: x.projectMetadataId! }],
        dependencies: [],
        graphs: [],
      },
      fingerprint: warningReview.fingerprint!,
      acknowledgedWarnings: warningReview.warnings.map((warning) => warning.id),
    },
    guard(),
  );
  assert.deepEqual(
    warned.warnings,
    warningReview.warnings,
    'The durable result retains the acknowledged warning locations',
  );
  await save(x, child);
  await save(x1, forkOnly);

  // Fence an edit that commits after preparation but before the topology transaction.
  const nextChoices: BundleMergeChoices = {
    ...choices,
    actions: choices.actions.map((action) =>
      action.kind === 'add'
        ? { kind: 'replace', sourceProjectId: action.sourceProjectId, targetProjectId: newId }
        : action,
    ),
  };
  const fresh = await backend.bundles.mergePreview(copy.bundleId, nextChoices);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await lockBundleTopology(blocker);
  const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const racing = backend.bundles.merge(
    copy.bundleId,
    {
      choices: nextChoices,
      fingerprint: fresh.fingerprint!,
      acknowledgedWarnings: fresh.warnings.map((value) => value.id),
    },
    guard(),
  );
  const observed = racing.then(
    () => null,
    (error) => error,
  );
  try {
    for (let index = 0; index < 50; index++) {
      const waiting = await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [
        blockerPid,
      ]);
      if (waiting.rowCount) break;
      if (index === 49) throw new Error('Merge did not reach the held topology lease.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const current = loadProjectAndAttachedDataFromString(
      (await backend.loadHostedProject(a1.absolutePath)).contents,
    )[0];
    current.metadata.description = 'edited during merge preparation';
    await save(a1, current, datasets(a1.projectMetadataId!, 'new-data'));
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.match(String(await observed), /consumed project changed/);

  // Opposite directions consume the same rows in reverse roles. Topology/row
  // ownership must serialize them: one wins, the other requires fresh review.
  const oppositeBundles = await Promise.all([
    backend.bundles.create(`Merge left ${randomUUID()}`, ''),
    backend.bundles.create(`Merge right ${randomUUID()}`, ''),
  ]);
  const oppositeProjects: WorkflowProjectItem[] = [];
  for (const bundle of oppositeBundles) {
    const item = await backend.createWorkflowProjectItem(bundle.relativePath, 'Project');
    const definition = structuredClone(fixture.child.project);
    remapBundleProject(definition, new Map([['bundle-child', item.projectMetadataId! as ProjectId]]));
    await save(item, definition);
    oppositeProjects.push(item);
  }
  const oppositeRequests = await Promise.all(
    oppositeBundles.map(async (sourceBundle, index) => {
      const targetBundle = oppositeBundles[1 - index]!;
      const oppositeChoices: BundleMergeChoices = {
        destinationBundleId: targetBundle.bundleId!,
        actions: [
          {
            kind: 'replace',
            sourceProjectId: oppositeProjects[index]!.projectMetadataId!,
            targetProjectId: oppositeProjects[1 - index]!.projectMetadataId!,
          },
        ],
        dependencies: [],
        graphs: [],
      };
      const review = await backend.bundles.mergePreview(sourceBundle.bundleId!, oppositeChoices);
      assert.ok(review.fingerprint);
      return {
        sourceId: sourceBundle.bundleId!,
        request: {
          choices: oppositeChoices,
          fingerprint: review.fingerprint!,
          acknowledgedWarnings: review.warnings.map((warning) => warning.id),
        },
        mutation: {
          ...guard(),
          expectedSource: { id: sourceBundle.namespaceId! },
          expectedDestinationId: targetBundle.namespaceId!,
        },
      };
    }),
  );
  const oppositeResults = await Promise.allSettled(
    oppositeRequests.map((item) => backend.bundles.merge(item.sourceId, item.request, item.mutation)),
  );
  assert.equal(oppositeResults.filter((value) => value.status === 'fulfilled').length, 1);
  for (const outcome of oppositeResults) {
    if (outcome.status === 'rejected')
      assert.equal(outcome.reason.status, 409, 'A stale opposite merge rejects without a deadlock');
  }
  for (const bundle of oppositeBundles)
    await backend.bundles.delete(bundle.bundleId!, { name: bundle.name, relativePath: bundle.relativePath });

  // An already-authored binding to a destination member keeps its Published
  // semantics even when the same merge replaces that member's latest draft.
  const xPublication = await backend.listWorkflowProjectWebApps(x.relativePath);
  await backend.publishWorkflowProjectItem(
    x.relativePath,
    { endpointName: `merge-pinned-${randomUUID()}` },
    {
      expectedProjectId: xPublication.projectId,
      expectedPublicationVersion: xPublication.publicationVersion,
      expectedDraftRevisionId: xPublication.draftRevisionId,
    },
  );
  const pinnedRevision = (
    await pool.query('SELECT published_revision_id FROM workflows WHERE workflow_id=$1', [x.projectMetadataId])
  ).rows[0].published_revision_id;
  const pinnedCaller = structuredClone(nextA);
  pinnedCaller.references = [];
  const pinnedCall = Object.values(pinnedCaller.graphs)[0]!.nodes.find(
    (node) => node.type === 'subGraph',
  ) as SubGraphNode;
  pinnedCall.data.targetProjectId = x.projectMetadataId as ProjectId;
  pinnedCall.data.targetVersion = 'published';
  const replacementX = structuredClone(forkOnly);
  replacementX.graphs = {};
  await save(x1, replacementX);
  await save(a1, pinnedCaller);
  const pinnedChoices: BundleMergeChoices = {
    destinationBundleId: original.bundleId!,
    actions: [
      { kind: 'replace', sourceProjectId: a1.projectMetadataId!, targetProjectId: a.projectMetadataId! },
      { kind: 'replace', sourceProjectId: x1.projectMetadataId!, targetProjectId: x.projectMetadataId! },
    ],
    dependencies: [],
    graphs: [],
  };
  const pinnedReview = await backend.bundles.mergePreview(copy.bundleId, pinnedChoices);
  assert.deepEqual(pinnedReview.blockers, []);
  assert.ok(pinnedReview.fingerprint, 'A valid Published target must not be checked against its replacement draft');
  assert.equal(pinnedReview.versionChanges, 0);
  await backend.bundles.merge(
    copy.bundleId,
    {
      choices: pinnedChoices,
      fingerprint: pinnedReview.fingerprint!,
      acknowledgedWarnings: pinnedReview.warnings.map((warning) => warning.id),
    },
    guard(),
  );
  const pinnedResult = loadProjectAndAttachedDataFromString(
    (await backend.loadHostedProject(a.absolutePath)).contents,
  )[0];
  const savedPinnedCall = Object.values(pinnedResult.graphs)[0]!.nodes.find(
    (node) => node.type === 'subGraph',
  ) as SubGraphNode;
  assert.equal(savedPinnedCall.data.targetProjectId, x.projectMetadataId);
  assert.equal(savedPinnedCall.data.targetVersion, 'published');
  assert.equal(
    (await pool.query('SELECT published_revision_id FROM workflows WHERE workflow_id=$1', [x.projectMetadataId]))
      .rows[0].published_revision_id,
    pinnedRevision,
  );
  const pinnedProcessor = createProcessor(pinnedResult, {
    subgraphProjectLoader: { loadTarget: (target) => backend.loadSubgraphTarget(target) },
  });
  try {
    assert.equal((await pinnedProcessor.run())['result']?.value, 'child-result');
  } finally {
    pinnedProcessor.dispose();
  }
  pinnedCall.data.targetVersion = 'latest';
  await save(a1, pinnedCaller);
  const latestReview = await backend.bundles.mergePreview(copy.bundleId, pinnedChoices);
  assert.equal(latestReview.fingerprint, undefined);
  assert.ok(latestReview.blockers.some((issue) => issue.site?.nodeId === pinnedCall.id));
  const legacyCaller = structuredClone(pinnedCaller);
  legacyCaller.references = [{ id: x.projectMetadataId! as ProjectId }];
  for (const graph of Object.values(legacyCaller.graphs))
    graph.nodes = graph.nodes.map((node) =>
      node.id === pinnedCall.id
        ? {
            ...node,
            type: 'referencedGraphAlias',
            data: {
              projectId: x.projectMetadataId!,
              graphId: pinnedCall.data.graphId,
              targetVersion: 'published',
            },
          }
        : node,
    );
  await save(a1, legacyCaller);
  const aliasReview = await backend.bundles.mergePreview(copy.bundleId, pinnedChoices);
  assert.equal(
    aliasReview.fingerprint,
    undefined,
    'Legacy aliases use latest references even with stale Subgraph metadata',
  );
  assert.ok(aliasReview.blockers.some((issue) => issue.site?.nodeId === pinnedCall.id));
  await backend.bundles.delete(copy.bundleId, { name: copied.name, relativePath: copied.relativePath });
  assert.deepEqual(
    await backend.bundles.merge(copy.bundleId, request, admission),
    result,
    'Receipt recovery remains observational after the source bundle is gone',
  );
  console.log(
    'Bundle merging: minimal mapping, destination execution, dataset removal, atomic rollback, persisted warnings, concurrent receipts, opposite merges and concurrent-save fencing passed.',
  );
}
