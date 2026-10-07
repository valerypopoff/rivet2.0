import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fsync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createLocalUpgradeSnapshotPlan } from './local-upgrade-snapshot-plan.mjs';
import { uiUpgradeBackupLayout } from '../images/api/local-upgrade-ui.mjs';

const execute = promisify(execFile);
const syncDescriptor = promisify(fsync);
export const BACKUP_DOMAINS = ['workflows', 'recordings', 'appData', 'runtimeLibraries'];
export const SQLITE_BACKUP_DOMAINS = [...BACKUP_DOMAINS, 'control'];
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const maxProofBytes = 64 * 1048576;
function proofJson(value) {
  const json = JSON.stringify(value);
  assert.ok(Buffer.byteLength(json) < maxProofBytes, 'Backup proof exceeds the supported metadata size.');
  return json;
}

export function verifyBackupManifestReceipt(manifest, expectedReceipt) {
  assert.ok(manifest.version === 1 || manifest.version === 2, 'Unsupported backup format.');
  const domains = manifest.version === 2 ? SQLITE_BACKUP_DOMAINS : BACKUP_DOMAINS;
  if (manifest.version === 2) {
    assert.equal(manifest.kind, 'sqlite-serving');
    assert.equal(manifest.selection.phase, 'sqlite-live');
    assert.match(manifest.selection.generationId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
  }
  assert.deepEqual(Object.keys(manifest.domains).sort(), [...domains].sort());
  assert.match(expectedReceipt, /^[a-f0-9]{64}$/);
  assert.equal(digest(manifest), expectedReceipt, 'Backup receipt differs; use the separately preserved receipt.');
}

export async function assertBackupDirectory(directory) {
  let cursor = path.resolve(directory);
  for (;;) {
    const stat = await fs.lstat(cursor);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe backup directory.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
export async function createFreshBackupDirectory(directory, sources) {
  directory = path.resolve(directory);
  await assertBackupDirectory(path.dirname(directory));
  for (const source of sources) assert.ok(!overlaps(directory, path.resolve(source)), 'Backup paths overlap.');
  const parent = await physicalPath(path.dirname(directory));
  for (const source of sources) {
    const root = await physicalPath(source);
    assert.ok(!parent.ancestors.has(root.identity), 'Backup destination aliases a source subtree.');
  }
  // No recursive mkdir, overwrite, cleanup or deletion of an existing target.
  await fs.mkdir(directory, { mode: 0o700 });
  return directory;
}
async function syncFile(file) {
  const handle = await fs.open(file, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await syncDescriptor(handle.fd);
  } finally {
    await handle.close();
  }
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return; // Linux is required for production backup.
  await syncFile(directory);
}

/** Stream one file at a time, preserving confined package links and modes.
 * Payloads and credentials never appear in the returned manifest. */
export async function scanBackupRoot(root, domain, destination) {
  root = path.resolve(root);
  await assertBackupDirectory(root);
  const entries = [];
  async function visit(relative) {
    const file = path.join(root, relative);
    const before = await fs.lstat(file);
    assert.equal(before.mode & 0o6000, 0, 'Set-ID permissions require a reviewed backup disposition.');
    const target = destination && path.join(destination, relative);
    const entry = { path: relative.split(path.sep).join('/'), mode: before.mode & 0o1777 };
    if (before.isSymbolicLink()) {
      const cacheParts = /^(?:ui-managed\/)?generations\/[^/]+\/runtime-cache\//.exec(entry.path);
      const cache = domain === 'control' && !!cacheParts;
      assert.ok(domain === 'runtimeLibraries' || cache, 'Only confined runtime-library symlinks are supported.');
      const link = await fs.readlink(file);
      const resolved = await fs.realpath(file);
      const linkRoot = cache ? path.join(root, cacheParts[0].slice(0, -1)) : root;
      assert.ok(!path.isAbsolute(link) && resolved.startsWith(linkRoot + path.sep), 'Escaping package link.');
      entry.type = 'link';
      entry.link = link;
      if (target) await fs.symlink(link, target);
    } else if (before.isDirectory()) {
      entry.type = 'directory';
      if (target) await fs.mkdir(target, { mode: 0o700 });
      entries.push(entry);
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
      if (target) {
        await fs.chmod(target, entry.mode);
        await syncDirectory(target);
      }
      return;
    } else {
      assert.ok(before.isFile(), 'Unsupported backup entry.');
      entry.type = 'file';
      entry.size = before.size;
      const hash = createHash('sha256');
      const input = await fs.open(file, 'r');
      let output;
      try {
        const opened = await input.stat();
        assert.equal(opened.ino, before.ino, 'Source changed before copy.');
        if (target) output = await fs.open(target, 'wx', 0o600);
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          hash.update(chunk);
          if (output) await output.writeFile(chunk);
        }
        if (output) {
          await output.chmod(entry.mode);
          await syncDescriptor(output.fd);
        }
        const after = await input.stat(),
          afterPath = await fs.lstat(file);
        for (const stat of [opened, after, afterPath])
          assert.ok(
            stat.isFile() &&
              !stat.isSymbolicLink() &&
              stat.dev === before.dev &&
              stat.ino === before.ino &&
              stat.size === before.size &&
              stat.mtimeMs === before.mtimeMs &&
              stat.ctimeMs === before.ctimeMs,
            'Source changed during backup.',
          );
      } finally {
        await input.close();
        await output?.close();
      }
      entry.sha256 = hash.digest('hex');
    }
    entries.push(entry);
  }
  await visit('');
  return entries;
}

async function physicalPath(directory) {
  const canonical = await fs.realpath(path.resolve(directory));
  const ancestors = new Set();
  let cursor = canonical,
    identity;
  for (;;) {
    const stat = await fs.stat(cursor, { bigint: true });
    const key = `${stat.dev}:${stat.ino}`;
    identity ??= key;
    ancestors.add(key);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { canonical, identity, ancestors };
}

/** Shared by backup and rehearsal preflight: different path strings are not
 * enough to establish independent authority roots when directories are aliased. */
export async function assertDisjointBackupDirectories(directories) {
  const sources = directories.map((directory) => path.resolve(directory));
  for (const source of sources) await assertBackupDirectory(source);
  for (let i = 0; i < sources.length; i++)
    for (let j = i + 1; j < sources.length; j++) assert.ok(!overlaps(sources[i], sources[j]), 'Source roots overlap.');
  const physical = await Promise.all(sources.map(physicalPath));
  for (let i = 0; i < physical.length; i++)
    for (let j = i + 1; j < physical.length; j++)
      assert.ok(
        !physical[i].ancestors.has(physical[j].identity) && !physical[j].ancestors.has(physical[i].identity),
        'Source roots physically overlap.',
      );
}

export async function assertNoBackupWriters(plan, containers) {
  assert.equal(plan.knownWritersStopped, true, 'Stop the API and executor in an approved maintenance window first.');
  const roots = await Promise.all(Object.values(plan.roots).map((root) => physicalPath(root.source)));
  for (const container of containers) {
    if (!container.State?.Running) continue;
    for (const mount of container.Mounts ?? []) {
      if (mount.RW === false || mount.Type === 'tmpfs') continue;
      assert.ok(typeof mount.Source === 'string' && path.isAbsolute(mount.Source), 'Unresolvable writable mount.');
      const mounted = await physicalPath(mount.Source);
      assert.ok(
        !roots.some(
          (root) =>
            overlaps(root.canonical, mounted.canonical) ||
            root.ancestors.has(mounted.identity) ||
            mounted.ancestors.has(root.identity),
        ),
        'A running container can write a source root.',
      );
    }
  }
}

/** No service stop/start and no source mutation. assertFrozen must also rule
 * out host writers; Docker inspection alone cannot prove that. */
export async function createLocalUpgradeBackup({
  roots,
  destination,
  assertFrozen,
  sourceImages = [],
  sqlite = false,
}) {
  const domains = sqlite ? SQLITE_BACKUP_DOMAINS : BACKUP_DOMAINS;
  assert.deepEqual(Object.keys(roots).sort(), [...domains].sort());
  const sources = domains.map((domain) => path.resolve(roots[domain]));
  await assertDisjointBackupDirectories(sources);
  await assertFrozen();
  const selection = sqlite ? await inspectSqliteServingBackup(roots.control, roots.appData) : null;
  destination = await createFreshBackupDirectory(destination, sources);
  const manifest = {
    version: sqlite ? 2 : 1,
    createdAt: new Date().toISOString(),
    sourceImages,
    domains: {},
    ...(sqlite ? { kind: 'sqlite-serving', selection } : {}),
  };
  for (const domain of domains) {
    await assertFrozen();
    manifest.domains[domain] = await scanBackupRoot(roots[domain], domain, path.join(destination, domain));
  }
  await assertFrozen();
  for (const domain of domains) {
    assert.deepEqual(
      await scanBackupRoot(roots[domain], domain),
      manifest.domains[domain],
      'Source changed during coordinated backup.',
    );
    assert.deepEqual(
      await scanBackupRoot(path.join(destination, domain), domain),
      manifest.domains[domain],
      'Backup readback differs.',
    );
  }
  await assertFrozen();
  if (sqlite) {
    assert.deepEqual(
      await inspectSqliteServingBackup(roots.control, roots.appData),
      selection,
      'Selected generation changed.',
    );
    assert.deepEqual(
      await inspectSqliteServingBackup(path.join(destination, 'control'), path.join(destination, 'appData')),
      selection,
    );
  }
  const receipt = digest(manifest);
  const file = path.join(destination, 'backup.json');
  await fs.writeFile(file, proofJson(manifest), { flag: 'wx', mode: 0o600 });
  await syncFile(file);
  await syncDirectory(destination);
  await syncDirectory(path.dirname(destination));
  return {
    destination,
    receipt,
    files: Object.values(manifest.domains)
      .flat()
      .filter((entry) => entry.type === 'file').length,
  };
}

export async function verifyLocalUpgradeBackup(directory, expectedReceipt) {
  directory = path.resolve(directory);
  await assertBackupDirectory(directory);
  const file = path.join(directory, 'backup.json');
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < maxProofBytes, 'Invalid backup manifest.');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  verifyBackupManifestReceipt(manifest, expectedReceipt);
  const domains = Object.keys(manifest.domains);
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    [...domains, 'backup.json'].sort(),
    'Unexpected backup root entries.',
  );
  for (const domain of domains)
    assert.deepEqual(
      await scanBackupRoot(path.join(directory, domain), domain),
      manifest.domains[domain],
      'Restored backup differs.',
    );
  if (manifest.version === 2)
    assert.deepEqual(
      await inspectSqliteServingBackup(path.join(directory, 'control'), path.join(directory, 'appData')),
      manifest.selection,
    );
  return manifest;
}

export async function restoreLocalUpgradeBackup({ backup, receipt, destination }) {
  const manifest = await verifyLocalUpgradeBackup(backup, receipt);
  destination = await createFreshBackupDirectory(destination, [backup]);
  for (const domain of Object.keys(manifest.domains)) {
    const actual = await scanBackupRoot(path.join(backup, domain), domain, path.join(destination, domain));
    assert.deepEqual(actual, manifest.domains[domain], 'Backup changed while restoring.');
    assert.deepEqual(await scanBackupRoot(path.join(destination, domain), domain), actual, 'Restore readback differs.');
  }
  await verifyLocalUpgradeBackup(backup, receipt);
  if (manifest.version === 2)
    assert.deepEqual(
      await inspectSqliteServingBackup(path.join(destination, 'control'), path.join(destination, 'appData')),
      manifest.selection,
    );
  // A restored copy has its own proof; never grant permission to mount the
  // original production paths or backup as writable rehearsal data.
  await fs.writeFile(
    path.join(destination, 'restored-copy.json'),
    proofJson({
      version: 2,
      backupReceipt: receipt,
      restoredAt: new Date().toISOString(),
      backupManifest: manifest,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  await syncFile(path.join(destination, 'restored-copy.json'));
  await syncDirectory(destination);
  await syncDirectory(path.dirname(destination));
  return { destination, receipt };
}

async function inspectDocker(names) {
  const result = await execute('docker', ['inspect', ...names], { maxBuffer: 16 * 1048576, windowsHide: true });
  return JSON.parse(result.stdout);
}

// Standalone Node 24 operator tools do not depend on the built API. Behavioral
// fixture tests check compatibility with its operational schema guard.
const operationalBackupSchemas = {
  'operational/evaluation-runs.sqlite': {
    evaluation_library: ['singleton_key', 'revision', 'library_json', 'updated_at_ms'],
    evaluation_library_imports: ['source_fingerprint', 'imported_at_ms'],
    evaluation_runs: ['project_id', 'run_id', 'suite_id', 'started_at', 'run_json', 'updated_at_ms'],
    evaluation_recordings: ['project_id', 'recording_id', 'run_id', 'artifact_json', 'created_at_ms'],
    evaluation_dataset_snapshots: ['project_id', 'dataset_fingerprint', 'snapshot_json', 'created_at_ms'],
    evaluation_deleted_projects: ['project_id', 'deleted_at_ms'],
  },
  'operational/llm-profile-health.sqlite': { llm_profile_health: ['key', 'project_id', 'entry_json', 'updated_at_ms'] },
};

function assertOperationalBackupSchema(database, schema) {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(tables, Object.keys(schema).sort(), 'Selected operational database has an unsupported schema.');
  for (const [table, required] of Object.entries(schema)) {
    const columns = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map(({ name }) => name);
    assert.ok(
      required.every((name) => columns.includes(name)),
      'Selected operational database has an incomplete schema.',
    );
  }
}

export function assertSettingsBackupSchema(database) {
  assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0x52495654);
  const version = database.prepare('PRAGMA user_version').get().user_version;
  assert.ok(version === 1 || version === 2, 'Selected settings schema version is unsupported.');
  const expected = `CREATE TABLE app_settings (
    setting_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
    ${
      version === 1
        ? `ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL CHECK (length(iv) = 12),
    auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
    key_id TEXT NOT NULL,`
        : 'value_json TEXT NOT NULL,'
    }
    source_hash TEXT,
    updated_at TEXT NOT NULL
  )`;
  const objects = database.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  assert.ok(
    objects.length === 1 &&
      objects[0].name === 'app_settings' &&
      objects[0].sql?.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim(),
    'Selected settings database has an unsupported schema.',
  );
  for (const row of database.prepare('SELECT * FROM app_settings').iterate()) {
    assert.ok(
      Number.isSafeInteger(row.revision) &&
        row.revision > 0 &&
        Number.isSafeInteger(row.schema_version) &&
        row.schema_version >= 0,
      'Selected settings database has an invalid revision.',
    );
    if (version === 2) {
      let value;
      try {
        value = JSON.parse(row.value_json);
      } catch {
        throw new Error('Selected settings JSON is invalid.');
      }
      assert.ok(
        value && typeof value === 'object' && !Array.isArray(value),
        'Selected settings value must be an object.',
      );
    }
  }
  return version;
}

/** Read-only validation of a stopped selected generation. This does not reset
 * journals, decrypt settings, drop caches or select a backend. */
export async function inspectSqliteServingBackup(controlRoot, appDataRoot) {
  const { DatabaseSync } = await import('node:sqlite');
  await assertBackupDirectory(controlRoot);
  // A UI-owned volume includes its private configuration and independent App
  // Data binding. Never inspect only its nested databases and lose that state.
  const uiLayout = uiUpgradeBackupLayout(controlRoot, appDataRoot);
  controlRoot = uiLayout.root;
  const open = async (file) => {
    await assertBackupDirectory(path.dirname(file));
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Missing or unsafe selected database.');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.ok(
        db
          .prepare('PRAGMA integrity_check')
          .all()
          .every((row) => row.integrity_check === 'ok'),
        'Database integrity failed.',
      );
      assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined, 'Database reference integrity failed.');
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  const journal = await open(path.join(controlRoot, 'transition.sqlite'));
  let state, proof;
  try {
    assert.equal(journal.prepare('PRAGMA application_id').get().application_id, 0x5249544a);
    assert.equal(journal.prepare('PRAGMA user_version').get().user_version, 1);
    state = journal.prepare('SELECT revision,phase,generation_id FROM transition_state WHERE singleton=1').get();
    assert.equal(state?.phase, 'sqlite-live', 'Backup requires resumed SQLite authority.');
    assert.match(state.generation_id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
    proof = JSON.parse(
      journal.prepare('SELECT proof_json FROM generations WHERE id=?').get(state.generation_id).proof_json,
    );
    assert.equal(proof.id, state.generation_id);
  } finally {
    journal.close();
  }
  const operators = await open(path.join(controlRoot, 'upgrade.sqlite'));
  let certificate;
  try {
    assert.equal(operators.prepare('PRAGMA application_id').get().application_id, 0x52495550);
    certificate = JSON.parse(
      operators.prepare('SELECT certificate_json FROM certificates WHERE generation_id=?').get(state.generation_id)
        .certificate_json,
    );
    assert.equal(digest(certificate), proof.reportHash, 'Selected certificate differs.');
    if (uiLayout.encryptionKeyId && certificate.encryptionKeyId)
      assert.equal(
        certificate.encryptionKeyId,
        uiLayout.encryptionKeyId,
        'UI configuration key differs from its certificate.',
      );
  } finally {
    operators.close();
  }
  const source = {
    workflows: '/workflows',
    recordings: '/workflow-recordings',
    appData: '/data/rivet-app',
    runtimeLibraries: '/data/runtime-libraries',
  };
  assert.deepEqual(certificate.source, source, 'Restore requires the original container root identities.');
  const generation = path.join(controlRoot, 'generations', state.generation_id);
  const catalog = await open(path.join(generation, 'catalog.sqlite'));
  try {
    assert.equal(catalog.prepare('PRAGMA application_id').get().application_id, 0x52495643);
    assert.equal(catalog.prepare('PRAGMA user_version').get().user_version, 2);
    const checked = new Map();
    const reference = async (value, required) => {
      if (value === null) {
        assert.ok(!required, 'Required catalog artifact is missing.');
        return;
      }
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid catalog artifact reference.');
      assert.equal(typeof value.hash, 'string', 'Invalid catalog artifact hash.');
      assert.match(value.hash, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(value.size) && value.size >= 0);
      if (checked.has(value.hash)) {
        assert.equal(checked.get(value.hash), value.size, 'Conflicting catalog artifact sizes.');
        return;
      }
      const file = path.join(generation, 'objects', value.hash.slice(0, 2), value.hash);
      await assertBackupDirectory(path.dirname(file));
      const stat = await fs.lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === value.size, 'Missing referenced artifact.');
      const hash = createHash('sha256');
      const handle = await fs.open(file, 'r');
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      } finally {
        await handle.close();
      }
      assert.equal(hash.digest('hex'), value.hash, 'Referenced artifact checksum differs.');
      checked.set(value.hash, value.size);
    };
    // These are the catalog schema's artifact fields, not arbitrary objects
    // that happen to contain hash/size. A malformed pointer must not be skipped.
    const fields = {
      projects: { contents: true, datasetsContents: false, publishedContents: false, publishedDatasetsContents: false },
      published_versions: { contents: true, datasetsContents: false },
      web_apps: { contents: true, datasetsContents: false },
      recordings: { recordingContents: true, replayProjectContents: true, replayDatasetContents: false },
      runtime_library_state: { archive: false },
    };
    for (const [table, references] of Object.entries(fields))
      for (const row of catalog.prepare('SELECT metadata_json FROM ' + table).iterate()) {
        const metadata = JSON.parse(row.metadata_json);
        for (const [field, required] of Object.entries(references)) await reference(metadata[field], required);
      }
  } finally {
    catalog.close();
  }
  for (const relative of [
    'settings.sqlite',
    'operational/evaluation-runs.sqlite',
    'operational/llm-profile-health.sqlite',
  ]) {
    // Conversion creates certified empty operational databases too. Missing a
    // selected database is data loss, not an unused optional domain.
    const file = path.join(generation, relative);
    const db = await open(file);
    try {
      if (relative === 'settings.sqlite') assertSettingsBackupSchema(db);
      else assertOperationalBackupSchema(db, operationalBackupSchemas[relative]);
    } finally {
      db.close();
    }
  }
  return {
    phase: state.phase,
    generationId: state.generation_id,
    revision: state.revision,
    source,
    ...(certificate.encryptionKeyId ? { encryptionKeyId: certificate.encryptionKeyId } : {}),
  };
}
async function main() {
  const args = process.argv.slice(2);
  const value = (key) => {
    const index = args.indexOf(key);
    assert.ok(index >= 0 && args[index + 1], `Missing ${key}.`);
    return args[index + 1];
  };
  if (args.includes('--restore')) {
    assert.ok(args.includes('--create'), 'Restore requires --create and a fresh destination.');
    console.log(
      JSON.stringify(
        await restoreLocalUpgradeBackup({
          backup: value('--restore'),
          receipt: value('--receipt'),
          destination: value('--destination'),
        }),
      ),
    );
    return;
  }
  if (args.includes('--verify')) {
    await verifyLocalUpgradeBackup(value('--verify'), value('--receipt'));
    console.log('Backup readback verified against the separately saved receipt.');
    return;
  }
  assert.equal(process.platform, 'linux', 'Production backup must run on the Linux source host.');
  const names = [value('--api'), ...(args.includes('--executor') ? [value('--executor')] : [])];
  names.forEach((name) => assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/));
  const sqlite = args.includes('--sqlite');
  const discover = async () => {
    const inspected = await inspectDocker(names);
    return createLocalUpgradeSnapshotPlan(inspected[0], inspected[1], { sqlite });
  };
  const plan = await discover();
  if (!args.includes('--create')) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  assert.ok(args.includes('--host-writers-stopped'), 'Explicit host-writer acknowledgement is required.');
  const assertFrozen = async () => {
    const current = await discover();
    assert.deepEqual(current.roots, plan.roots, 'Source mounts changed.');
    assert.deepEqual(current.writers, plan.writers, 'Source writers changed.');
    const listed = await execute('docker', ['ps', '-aq'], { windowsHide: true });
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    await assertNoBackupWriters(current, ids.length ? await inspectDocker(ids) : []);
  };
  console.log(
    JSON.stringify(
      await createLocalUpgradeBackup({
        roots: Object.fromEntries(Object.entries(plan.roots).map(([domain, root]) => [domain, root.source])),
        destination: value('--destination'),
        sourceImages: plan.writers.map(({ container, imageId }) => ({ container, imageId })),
        assertFrozen,
        sqlite,
      }),
    ),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      'Backup/restore refused or failed. Source authority was not changed. Keep any partial destination for diagnosis; no valid receipt was issued.',
    );
    process.exitCode = 1;
  });
