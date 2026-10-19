import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createProcessor,
  loadProjectAndAttachedDataFromString,
  serializeProject,
  serializeDatasets,
  deserializeDatasets,
  type DatasetId,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type { ManagedWorkflowBackend } from '../../routes/workflows/managed/backend.js';
import { projectBundleFixture } from './project-bundle-fixture.js';
import { remapBundleProject } from '../../routes/workflows/remap-bundle-project.js';
import { verifyExplicitBundleRoundtrip } from './explicit-bundle-roundtrip.js';

/** Uses only the owning integration's fresh database and bucket. */
export async function verifyExplicitBundleContract(
  backend: ManagedWorkflowBackend,
  pool: Pool,
  http?: { baseUrl: string; headers: Record<string, string> },
) {
  if (http) {
    const url = `${http.baseUrl}/api/workflows/bundles`;
    const body = JSON.stringify({ name: `HTTP bundle ${randomUUID()}`, parentRelativePath: '' });
    const headers = { ...http.headers, 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' };
    const invalid = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Broken.rivet-project', parentRelativePath: '' }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(invalid.status, 400, await invalid.text());
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          body,
          headers: { ...headers, 'X-Rivet-Bundle-Intent': '0' },
          signal: AbortSignal.timeout(10_000),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          body,
          headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
          signal: AbortSignal.timeout(10_000),
        })
      ).status,
      403,
    );
    const response = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 201, await response.clone().text());
    const created = (await response.json()) as { folder: { relativePath: string; bundleId: string } };
    assert.ok(created.folder.bundleId);
    await backend.deleteWorkflowFolderItem(created.folder.relativePath);
  }
  const source = await backend.bundles.create(`Explicit ${randomUUID()}`, '');
  assert.ok(source.bundleId);
  await assert.rejects(backend.createWorkflowFolderItem('Broken.rivet-project', source.relativePath), { status: 400 });
  const nested = await backend.createWorkflowFolderItem('Nested', source.relativePath);
  await assert.rejects(backend.renameWorkflowFolderItem(nested.relativePath, 'Broken.rivet-project'), { status: 400 });
  const root = await backend.createWorkflowProjectItem(source.relativePath, 'Caller');
  const child = await backend.createWorkflowProjectItem(nested.relativePath, 'Child');
  const unused = await backend.createWorkflowProjectItem(source.relativePath, 'Unused');
  const outsider = await backend.createWorkflowProjectItem('', `Outside ${randomUUID()}`);
  const foreign = await backend.bundles.create(`Foreign ${randomUUID()}`, '');
  const foreignMember = await backend.createWorkflowProjectItem(foreign.relativePath, 'Foreign member');
  for (const [caller, target, allowed] of [
    [root, child, true],
    [root, outsider, true],
    [outsider, child, false],
    [foreignMember, child, false],
    [root, foreignMember, false],
  ] as const) {
    const selection = {
      projectId: target.projectMetadataId! as ProjectId,
      version: 'latest' as const,
      callerProjectId: caller.projectMetadataId! as ProjectId,
    };
    if (allowed) await backend.loadSubgraphTarget(selection);
    else await assert.rejects(backend.loadSubgraphTarget(selection), { status: 403 });
    if (http)
      for (const operation of ['access', 'preview', 'execution']) {
        const response: Response = await fetch(
          `${http.baseUrl}/api/workflows/subgraph-projects/${selection.projectId}/${operation}?version=latest&callerProjectId=${selection.callerProjectId}`,
          { headers: http.headers, signal: AbortSignal.timeout(10_000) },
        );
        assert.equal(response.status, allowed ? (operation === 'access' ? 204 : 200) : 403);
        await response.arrayBuffer();
      }
  }
  await assert.rejects(
    backend.validateSubgraphTarget({ projectId: child.projectMetadataId! as ProjectId, version: 'latest' }),
    { status: 403 },
  );
  if (http)
    for (const operation of ['preview', 'execution']) {
      const response: Response = await fetch(
        `${http.baseUrl}/api/workflows/subgraph-projects/${child.projectMetadataId}/${operation}?version=latest`,
        { headers: http.headers, signal: AbortSignal.timeout(10_000) },
      );
      assert.equal(response.status, 403, 'public target reads must not take the internal root-snapshot exemption');
      await response.arrayBuffer();
    }
  // A warm definition must not authorize a caller after a hierarchy move.
  await backend.moveWorkflowProject(foreignMember.relativePath, source.relativePath);
  await backend.validateSubgraphTarget({
    projectId: foreignMember.projectMetadataId! as ProjectId,
    version: 'latest',
    callerProjectId: root.projectMetadataId! as ProjectId,
  });
  await backend.deleteWorkflowProjectItem(`${source.relativePath}/Foreign member.rivet-project`);
  await backend.deleteWorkflowFolderItem(foreign.relativePath);
  await backend.deleteWorkflowProjectItem(outsider.relativePath);
  const fixture = projectBundleFixture();
  const ids = new Map([
    ['bundle-root', root.projectMetadataId! as ProjectId],
    ['bundle-child', child.projectMetadataId! as ProjectId],
  ]);
  for (const [item, definition] of [
    [root, fixture.root.project],
    [child, fixture.child.project],
  ] as const) {
    remapBundleProject(definition, ids);
    const loaded = await backend.loadHostedProject(item.absolutePath);
    await backend.saveHostedProject({
      projectPath: item.absolutePath,
      projectId: item.projectMetadataId,
      contents: serializeProject(definition) as string,
      datasetsContents: serializeDatasets([
        {
          meta: { id: 'data' as DatasetId, projectId: definition.metadata.id, name: 'Data', description: '' },
          data: { id: 'data' as DatasetId, rows: [{ id: 'row', data: ['preserved'] }] },
        },
      ]),
      expectedRevisionId: loaded.revisionId,
      saveIntent: 'in-place',
    });
  }
  for (const item of [child, root]) {
    const review = await backend.listWorkflowProjectWebApps(item.relativePath);
    await backend.publishWorkflowProjectItem(
      item.relativePath,
      { endpointName: `copy-source-${randomUUID()}` },
      {
        expectedProjectId: review.projectId,
        expectedPublicationVersion: review.publicationVersion,
        expectedDraftRevisionId: review.draftRevisionId,
      },
    );
  }
  const originalChild = await backend.loadHostedProject(child.absolutePath);
  const [changedChild, attached] = loadProjectAndAttachedDataFromString(originalChild.contents);
  (Object.values(changedChild.graphs)[0]!.nodes.find((node) => node.type === 'text')!.data as { text: string }).text =
    'latest-only';
  await backend.saveHostedProject({
    projectPath: child.absolutePath,
    projectId: child.projectMetadataId,
    contents: serializeProject(changedChild, attached) as string,
    datasetsContents: originalChild.datasetsContents,
    expectedRevisionId: originalChild.revisionId,
    saveIntent: 'in-place',
  });
  // Exercise the actual save service, including folder preparation, not merely
  // its final UPDATE: neither unchanged nor edited saves may request topology.
  const topology = await pool.connect();
  const savedRoot = await backend.loadHostedProject(root.absolutePath);
  const [editedRoot, rootAttached] = loadProjectAndAttachedDataFromString(savedRoot.contents);
  editedRoot.metadata.description = 'An ordinary edit while bundle topology is busy';
  let save: Promise<unknown> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await topology.query('BEGIN');
    await topology.query('SELECT pg_advisory_xact_lock(8071,24016)');
    for (const contents of [savedRoot.contents, serializeProject(editedRoot, rootAttached) as string]) {
      save = backend.saveHostedProject({
        projectPath: root.absolutePath,
        projectId: root.projectMetadataId,
        contents,
        datasetsContents: savedRoot.datasetsContents,
        expectedRevisionId: savedRoot.revisionId,
        saveIntent: 'in-place',
      });
      await Promise.race([
        save,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Ordinary save waited for the bundle topology lock')), 5_000);
        }),
      ]);
      clearTimeout(timeout);
    }
  } finally {
    clearTimeout(timeout);
    await topology.query('ROLLBACK');
    topology.release();
    // A failing regression must settle its writer before fixture cleanup.
    await save?.catch(() => {});
  }
  const preview = await backend.bundles.preview(source.bundleId, 'published');
  assert.equal(preview.members.length, 3, 'disconnected members belong to the explicit container');
  assert.equal(preview.members.filter((member) => member.selectedVersion === 'published').length, 2);
  assert.equal(
    preview.members.find((member) => member.projectId === unused.projectMetadataId)?.selectedVersion,
    'latest',
  );
  const copy = await backend.bundles.duplicate(source.bundleId, {
    name: `${source.name} copy`,
    parentRelativePath: '',
    version: 'published',
    fingerprint: preview.fingerprint,
  });
  assert.notEqual(copy.bundleId, source.bundleId);
  const copiedTree = (await backend.getTree()).folders.find((folder) => folder.bundleId === copy.bundleId)!;
  const copiedRoot = copiedTree.projects.find((project) => project.name === 'Caller')!;
  const copiedChild = copiedTree.folders[0]!.projects[0]!;
  assert.ok(copiedTree.projects.some((project) => project.name === unused.name));
  assert.equal(copiedRoot.bundleId, copy.bundleId);
  assert.equal(copiedChild.bundleId, copy.bundleId);
  const childData = deserializeDatasets((await backend.loadHostedProject(copiedChild.absolutePath)).datasetsContents!);
  assert.equal(childData[0]!.meta.projectId, copiedChild.projectMetadataId);
  assert.deepEqual(childData[0]!.data.rows[0]!.data, ['preserved']);
  const [definition] = loadProjectAndAttachedDataFromString(
    (await backend.loadHostedProject(copiedRoot.absolutePath)).contents,
  );
  const call = Object.values(definition.graphs)[0]!.nodes.find((node) => node.type === 'subGraph')!;
  assert.equal((call.data as { targetProjectId: string }).targetProjectId, copiedChild.projectMetadataId);
  assert.equal(copiedRoot.settings.status, 'unpublished');
  const processor = createProcessor(definition, {
    subgraphProjectLoader: { loadTarget: (target) => backend.loadSubgraphTarget(target) },
  });
  assert.equal((await processor.run())['result']?.value, 'child-result');
  processor.dispose();
  if (http) await verifyExplicitBundleRoundtrip(backend, http, source, root, child, unused);
  const failName = `${source.name} rollback`;
  await pool.query(`CREATE FUNCTION fixture_bundle_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.name='Unused' THEN RAISE EXCEPTION 'fixture bundle insert failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fixture_bundle_failure BEFORE INSERT ON workflows FOR EACH ROW EXECUTE FUNCTION fixture_bundle_failure();`);
  try {
    await assert.rejects(
      backend.bundles.duplicate(source.bundleId, {
        name: failName,
        parentRelativePath: '',
        version: 'published',
        fingerprint: preview.fingerprint,
      }),
      /fixture bundle insert failure/,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM workflow_folders WHERE name=$1', [failName])).rows[0].n,
      0,
    );
  } finally {
    await pool.query('DROP TRIGGER fixture_bundle_failure ON workflows; DROP FUNCTION fixture_bundle_failure()');
  }
  await backend.createWorkflowProjectItem(source.relativePath, 'Concurrent addition');
  await assert.rejects(
    backend.bundles.duplicate(source.bundleId, {
      name: 'Must not appear',
      parentRelativePath: '',
      version: 'published',
      fingerprint: preview.fingerprint,
    }),
    /changed/,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM workflow_folders WHERE name='Must not appear'")).rows[0].n,
    0,
  );
  await assert.rejects(backend.bundles.create('Nested bundle', nested.relativePath), /Bundles cannot contain/);
  await assert.rejects(
    backend.moveWorkflowFolder(copy.folder.relativePath, nested.relativePath),
    /Bundles cannot contain/,
  );
  const moved = await backend.renameWorkflowFolderItem(copy.folder.relativePath, `${source.name} moved`);
  const retained = (await backend.getTree()).folders.find(
    (folder) => folder.relativePath === moved.folder.relativePath,
  )!;
  assert.equal(retained.bundleId, copy.bundleId);
  await backend.bundles.setKind(retained.relativePath, false);
  assert.ok(
    !(await backend.getTree()).folders.find((folder) => folder.relativePath === retained.relativePath)!.bundleId,
  );
  await backend.bundles.setKind(retained.relativePath, true);
  const recast = (await backend.getTree()).folders.find((folder) => folder.relativePath === retained.relativePath)!;
  assert.notEqual(recast.bundleId, copy.bundleId, 'conversion removes the previous group identity');
  for (const folder of [source, recast]) {
    const tree = (await backend.getTree()).folders.find((candidate) => candidate.relativePath === folder.relativePath)!;
    for (const item of [...tree.projects, ...tree.folders.flatMap((folder) => folder.projects)]) {
      const review = await backend.listWorkflowProjectWebApps(item.relativePath);
      if (review.project.settings.status !== 'unpublished')
        await backend.unpublishWorkflowProjectItem(item.relativePath, {
          expectedProjectId: review.projectId,
          expectedPublicationVersion: review.publicationVersion,
        });
      await backend.deleteWorkflowProjectItem(item.relativePath);
    }
    for (const child of tree.folders) await backend.deleteWorkflowFolderItem(child.relativePath);
    await backend.deleteWorkflowFolderItem(tree.relativePath);
  }
}
