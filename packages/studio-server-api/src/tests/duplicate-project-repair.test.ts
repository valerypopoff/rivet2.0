// test-style: fixture-read: verifies byte preservation and recovery using generated project/history fixtures only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { deserializeProject, serializeProject, type NodeId, type ProjectId } from '@valerypopoff/rivet2-node';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { createWorkflowPublicationStateHashFromContents } from '../routes/workflows/publication.js';
import { checkLocalWorkflowSource } from '../local-metadata/filesystem-workflow-source.js';
import {
  inspectDuplicateProjectIds,
  repairDuplicateProjectIds,
  duplicateRepairStatus,
  assertNoPendingDuplicateRepair,
  finishDuplicateProjectRepair,
  duplicateRepairDownload,
} from '../local-metadata/duplicate-project-repair.js';
import type { LocalUpgradeDuplicateRepairChoices } from '../../../studio-server-shared/local-upgrade-types.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-id-repair-'));
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app'),
    runtimeLibraries: path.join(root, 'libraries'),
  };
  const control = path.join(root, 'control');
  for (const directory of [
    ...Object.values(source),
    control,
    path.join(source.workflows, 'trash'),
    path.join(source.workflows, '.published'),
  ])
    await fs.mkdir(directory, { recursive: true });
  const id = randomUUID();
  const a = 'trash/provider.rivet-project',
    b = 'trash/Copy.rivet-project';
  const project = (name: string) => {
    const [project] = deserializeProject(createBlankProjectFile(name), null, { logErrors: false });
    project.metadata.id = id as ProjectId;
    return serializeProject(project, { custom: { secret: 'retained-private-data' } }) as string;
  };
  const aText = project('provider'),
    bText = project('Copy');
  await fs.writeFile(path.join(source.workflows, a), aText);
  await fs.writeFile(path.join(source.workflows, b), bText);
  const history = randomUUID();
  const metadata = {
    version: 1,
    id: history,
    projectId: id,
    projectName: 'Copy',
    relativePath: 'old/Copy.rivet-project',
    endpointName: 'copy',
    publishedAt: '2026-10-05T00:00:00.000Z',
    stateHash: createWorkflowPublicationStateHashFromContents(bText, '{"datasets":[]}', 'copy'),
    isStarred: true,
    comment: 'keep me',
  };
  await fs.writeFile(path.join(source.workflows, '.published', `${history}.json`), JSON.stringify(metadata));
  await fs.writeFile(path.join(source.workflows, '.published', `${history}.rivet-project`), bText);
  await fs.writeFile(path.join(source.workflows, '.published', `${history}.rivet-data`), '{"datasets":[]}');
  const options = { control, source, revision: 1, pausedAt: '2026-10-08T00:00:00Z', assertFrozen: async () => {} };
  const choices = async (): Promise<LocalUpgradeDuplicateRepairChoices> => ({
    token: (await inspectDuplicateProjectIds(source)).token,
    retainReferences: true,
    groups: [{ projectId: id, keeperPath: a, historyOwners: { [history]: b } }],
  });
  return { root, source, control, id, a, b, aText, bText, history, metadata, options, choices };
}

test('guided identity repair preserves all projects, attached data, datasets and publication history', async () => {
  const f = await fixture();
  try {
    const preview = await inspectDuplicateProjectIds(f.source);
    assert.equal(preview.groups.length, 1);
    assert.equal(
      preview.groups[0]!.history[0]!.suggestedOwner,
      f.b,
      'unique basename proposes moved history, not silent ownership',
    );
    assert.equal(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'), f.bText, 'inspection is read-only');
    await repairDuplicateProjectIds({ ...f.options, choices: await f.choices() });
    const status = await duplicateRepairStatus(f.control);
    assert.equal(status?.phase, 'complete');
    assert.equal(status?.changedFiles, 3);
    await assertNoPendingDuplicateRepair(f.control);
    const [next, attached] = deserializeProject(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'));
    assert.notEqual(next.metadata.id, f.id);
    assert.deepEqual(attached, { custom: { secret: 'retained-private-data' } });
    assert.equal(await fs.readFile(path.join(f.source.workflows, f.a), 'utf8'), f.aText);
    const snapshot = await fs.readFile(
      path.join(f.source.workflows, '.published', `${f.history}.rivet-project`),
      'utf8',
    );
    const history = JSON.parse(
      await fs.readFile(path.join(f.source.workflows, '.published', `${f.history}.json`), 'utf8'),
    );
    assert.equal(history.projectId, next.metadata.id);
    assert.equal(deserializeProject(snapshot)[0].metadata.id, next.metadata.id);
    assert.deepEqual({ ...history, projectId: f.id, stateHash: f.metadata.stateHash }, f.metadata);
    assert.equal(
      history.stateHash,
      createWorkflowPublicationStateHashFromContents(snapshot, '{"datasets":[]}', 'copy'),
    );
    assert.equal(
      await fs.readFile(path.join(f.source.workflows, '.published', `${f.history}.rivet-data`), 'utf8'),
      '{"datasets":[]}',
    );
    assert.equal((await inspectDuplicateProjectIds(f.source)).groups.length, 0);
    await withEnvOverride('RIVET_EXTRA_ROOTS', f.root, async () => {
      assert.deepEqual(await checkLocalWorkflowSource(f.source.workflows), { projects: 2, folders: 1 });
    });
    assert.ok((await fs.stat(await duplicateRepairDownload(f.control, status!.id))).size > 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('stale or incomplete ownership cannot change source files', async () => {
  const f = await fixture();
  try {
    const choices = await f.choices();
    await fs.appendFile(path.join(f.source.workflows, f.a), '\n');
    await assert.rejects(repairDuplicateProjectIds({ ...f.options, choices }), /Source data changed/);
    assert.equal(await duplicateRepairStatus(f.control), null);
    const fresh = await f.choices();
    fresh.groups[0]!.historyOwners = {};
    await assert.rejects(
      repairDuplicateProjectIds({ ...f.options, choices: fresh }),
      /Assign every historical publication/,
    );
    assert.equal(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'), f.bText);
    assert.equal(await duplicateRepairStatus(f.control), null);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('interrupted multi-file repair is fenced, detects foreign changes, and finishes the original IDs after restart', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      repairDuplicateProjectIds({
        ...f.options,
        choices: await f.choices(),
        checkpoint: async (point) => {
          if (point === 'repair:applied:0') throw new Error('crash fixture');
        },
      }),
      /crash fixture/,
    );
    const status = await duplicateRepairStatus(f.control);
    assert.equal(status?.phase, 'applying');
    assert.throws(() => assertNoPendingDuplicateRepair(f.control), /Finish the interrupted/);
    await assert.rejects(finishDuplicateProjectRepair({ ...f.options, revision: 2 }), /does not match/);
    await assert.rejects(
      finishDuplicateProjectRepair({ ...f.options, source: { ...f.source, appData: path.join(f.root, 'other-app') } }),
      /does not match/,
    );
    const metadataPath = path.join(f.source.workflows, '.published', `${f.history}.json`);
    const original = await fs.readFile(metadataPath, 'utf8');
    await fs.writeFile(metadataPath, '{}');
    await assert.rejects(finishDuplicateProjectRepair(f.options), /Source differs/);
    await fs.writeFile(metadataPath, original);
    const staging = path.join(f.source.workflows, '.published', `.project-id-repair-${status!.id}-1.tmp`);
    await fs.writeFile(staging, 'incomplete staging write');
    const unrelated = path.join(f.source.workflows, '.published', '.unrelated.tmp');
    await fs.writeFile(unrelated, 'not owned by this repair');
    await finishDuplicateProjectRepair(f.options);
    await assert.rejects(fs.stat(staging), { code: 'ENOENT' });
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'not owned by this repair');
    assert.equal((await duplicateRepairStatus(f.control))?.phase, 'complete');
    assert.equal(
      deserializeProject(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'))[0].metadata.id,
      status!.assignments[0]!.newId,
    );
    assert.equal((await inspectDuplicateProjectIds(f.source)).groups.length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('an invalid journal and a damaged backup fail closed, without overwriting remaining files', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      repairDuplicateProjectIds({
        ...f.options,
        choices: await f.choices(),
        checkpoint: async () => {
          throw new Error('prepared crash');
        },
      }),
      /prepared crash/,
    );
    const status = await duplicateRepairStatus(f.control);
    const archive = await duplicateRepairDownload(f.control, status!.id);
    await fs.appendFile(archive, 'tamper');
    await assert.rejects(finishDuplicateProjectRepair(f.options), /backup checksum mismatch/);
    assert.equal(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'), f.bText);
    await fs.writeFile(path.join(f.control, 'duplicate-project-repair.json'), '{}');
    assert.throws(() => assertNoPendingDuplicateRepair(f.control));
    await fs.writeFile(path.join(f.control, 'duplicate-project-repair.json'), Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => assertNoPendingDuplicateRepair(f.control), /Invalid repair journal/);
    await fs.writeFile(path.join(f.control, 'duplicate-project-repair.json'), Buffer.from([0xff]));
    assert.throws(() => assertNoPendingDuplicateRepair(f.control));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('active publication keeps its identity and snapshot ownership; unpublished duplicates can still be preserved', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      path.join(f.source.workflows, `${f.b}.wrapper-settings.json`),
      JSON.stringify({ publishedSnapshotId: f.history, publishedEndpointName: 'copy' }),
    );
    const preview = await inspectDuplicateProjectIds(f.source);
    assert.equal(preview.groups[0]!.history[0]!.activeOwner, f.b);
    await assert.rejects(
      repairDuplicateProjectIds({ ...f.options, choices: await f.choices() }),
      /Unpublish endpoints/,
    );
    assert.equal(await duplicateRepairStatus(f.control), null);
    const choices = await f.choices();
    choices.groups[0]!.keeperPath = f.b;
    choices.groups[0]!.historyOwners[f.history] = f.a;
    await assert.rejects(repairDuplicateProjectIds({ ...f.options, choices }), /Invalid publication owner/);
    choices.groups[0]!.historyOwners[f.history] = f.b;
    await repairDuplicateProjectIds({ ...f.options, choices });
    assert.equal(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'), f.bText);
    assert.equal((await duplicateRepairStatus(f.control))?.changedFiles, 1);
    assert.equal(
      await fs.readFile(path.join(f.source.workflows, '.published', `${f.history}.rivet-project`), 'utf8'),
      f.bText,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('unresolved library links warn without blocking repair; ID-keyed references and payloads stay with the keeper', async () => {
  const f = await fixture();
  try {
    const [project, attached] = deserializeProject(f.bText);
    const graph = Object.values(project.graphs)[0]!;
    const node = (type: string, data: unknown) => ({
      type,
      data,
      id: randomUUID() as NodeId,
      title: type,
      visualData: { x: 0, y: 0 },
    });
    graph.nodes.push(node('nodePrefabInstance', { prefabId: 'missing-library-node' }));
    graph.nodes.push(node('subGraph', { targetProjectId: f.id }));
    const contents = serializeProject(project, attached) as string;
    await fs.writeFile(path.join(f.source.workflows, f.b), contents);
    const recordings = path.join(f.source.recordings, f.id, randomUUID());
    await fs.mkdir(recordings, { recursive: true });
    const artifact = Buffer.from('recording payload is not expanded or rewritten by identity repair');
    await fs.writeFile(path.join(recordings, 'recording.json.gz'), artifact);
    const database = new DatabaseSync(path.join(f.source.appData, 'scheduled-runs.sqlite'));
    try {
      database.exec('CREATE TABLE rivet_schedules (json TEXT NOT NULL)');
      database
        .prepare('INSERT INTO rivet_schedules VALUES (?)')
        .run(JSON.stringify({ projectId: f.id, enabled: true }));
    } finally {
      database.close();
    }
    const preview = await inspectDuplicateProjectIds(f.source);
    assert.match(preview.warnings[0]!, /reference discovery is incomplete/);
    assert.deepEqual(preview.groups[0]!.references, [f.b]);
    assert.equal(preview.groups[0]!.recordings, 1);
    assert.equal(preview.groups[0]!.operationalRows, 1);
    await repairDuplicateProjectIds({ ...f.options, choices: await f.choices() });
    const [repaired] = deserializeProject(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'));
    const [expected] = deserializeProject(contents);
    expected.metadata.id = repaired.metadata.id;
    assert.deepEqual(repaired, expected, 'only project identity changes, not referenced identities or missing links');
    assert.deepEqual(await fs.readFile(path.join(recordings, 'recording.json.gz')), artifact);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('malformed archive metadata gives a fixed diagnostic without source mutation', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.source.workflows, '.published', `${f.history}.json`), '{private-corrupt-value');
    await assert.rejects(inspectDuplicateProjectIds(f.source), (error: unknown) => {
      assert.equal((error as { reason: string }).reason, 'publication-history-invalid');
      assert.equal((error as Error).message.includes('private-corrupt-value'), false);
      return true;
    });
    assert.equal(await fs.readFile(path.join(f.source.workflows, f.b), 'utf8'), f.bText);
    assert.equal(await duplicateRepairStatus(f.control), null);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('older LLM health identities remain visible in ownership counts without changing their stored rows', async () => {
  for (const scalarColumn of [false, true]) {
    const f = await fixture();
    try {
      const file = path.join(f.source.appData, 'llm-profile-health.sqlite');
      const database = new DatabaseSync(file);
      try {
        database.exec(
          `CREATE TABLE llm_profile_health (key TEXT PRIMARY KEY, entry_json TEXT NOT NULL${scalarColumn ? ', project_id TEXT' : ''})`,
        );
        database
          .prepare('INSERT INTO llm_profile_health (key, entry_json) VALUES (?, ?)')
          .run('old-row', JSON.stringify({ identity: { projectId: f.id }, failureTimestamps: [] }));
      } finally {
        database.close();
      }
      const before = await fs.readFile(file);
      assert.equal((await inspectDuplicateProjectIds(f.source)).groups[0]!.operationalRows, 1);
      await repairDuplicateProjectIds({ ...f.options, choices: await f.choices() });
      assert.deepEqual(await fs.readFile(file), before, 'discovery and repair never backfill or edit operational rows');
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }
});

test('a crash after the final source replacement remains fenced and completes without rewriting documents', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      repairDuplicateProjectIds({
        ...f.options,
        choices: await f.choices(),
        checkpoint: async (point) => {
          if (point === 'repair:applied:2') throw new Error('final replacement crash');
        },
      }),
      /final replacement crash/,
    );
    assert.equal(
      (await inspectDuplicateProjectIds(f.source)).groups.length,
      0,
      'unique IDs do not prove journal completion',
    );
    assert.equal((await duplicateRepairStatus(f.control))?.phase, 'applying');
    assert.throws(() => assertNoPendingDuplicateRepair(f.control), /Finish the interrupted/);
    const files = [f.a, f.b, `.published/${f.history}.rivet-project`, `.published/${f.history}.json`];
    const contents = await Promise.all(files.map((file) => fs.readFile(path.join(f.source.workflows, file))));
    const replacements: string[] = [];
    await finishDuplicateProjectRepair({
      ...f.options,
      checkpoint: async (point) => {
        replacements.push(point);
      },
    });
    assert.deepEqual(replacements, [], 'already applied files are not replaced a second time');
    assert.equal((await duplicateRepairStatus(f.control))?.phase, 'complete');
    assert.deepEqual(
      await Promise.all(files.map((file) => fs.readFile(path.join(f.source.workflows, file)))),
      contents,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('reference discovery includes active published callers and invalidates choices when their snapshot changes', async () => {
  const f = await fixture();
  try {
    const caller = 'caller.rivet-project';
    const draft = createBlankProjectFile('caller');
    await fs.writeFile(path.join(f.source.workflows, caller), draft);
    const snapshotId = randomUUID();
    await fs.writeFile(
      path.join(f.source.workflows, `${caller}.wrapper-settings.json`),
      JSON.stringify({ publishedEndpointName: 'caller', publishedSnapshotId: snapshotId }),
    );
    const [project] = deserializeProject(draft);
    Object.values(project.graphs)[0]!.nodes.push(
      {
        type: 'subGraph',
        data: { targetProjectId: f.id },
        id: randomUUID() as NodeId,
        title: 'Call',
        visualData: { x: 0, y: 0 },
      },
      {
        type: 'nodePrefabInstance',
        data: { prefabId: 'missing' },
        id: randomUUID() as NodeId,
        title: 'Missing',
        visualData: { x: 0, y: 0 },
      },
    );
    const snapshot = path.join(f.source.workflows, '.published', `${snapshotId}.rivet-project`);
    await fs.writeFile(snapshot, serializeProject(project) as string);
    const preview = await inspectDuplicateProjectIds(f.source);
    assert.deepEqual(preview.groups[0]!.references, [caller], 'the current draft has no calls');
    assert.match(preview.warnings[0]!, /published snapshot of caller/);
    const choices = await f.choices();
    project.metadata.description = 'published contents changed';
    await fs.writeFile(snapshot, serializeProject(project) as string);
    await assert.rejects(repairDuplicateProjectIds({ ...f.options, choices }), /Source data changed/);
    assert.equal(await duplicateRepairStatus(f.control), null);
    await fs.rm(snapshot);
    const missing = await inspectDuplicateProjectIds(f.source);
    assert.match(missing.warnings[0]!, /Missing active published snapshot/);
    assert.deepEqual(missing.groups[0]!.references, []);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
