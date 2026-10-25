import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireMaintenanceLock } from './maintenance-lock.mjs';

test('kernel lock survives owner closure while a maintenance descendant holds its descriptor', async (t) => {
  assert.equal(process.platform, 'linux', 'Run this mandatory suite in the Linux test container.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-housekeeping-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await acquireMaintenanceLock(root);
  assert.ok(first);
  assert.equal(await acquireMaintenanceLock(root), null);
  const preload = fileURLToPath(new URL('./maintenance-lock-inherit.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    ['--import', preload, '-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'],
    {
      env: { ...process.env, RIVET_LEGACY_RESTORE_ROOT: root, RIVET_MAINTENANCE_LOCK_INHERITED: '1' },
      stdio: ['ignore', 'pipe', 'inherit', first.fd],
    },
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    child.kill('SIGKILL');
    await closed;
  });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  await first.close();
  assert.equal(await acquireMaintenanceLock(root), null, 'parent death/closure must not release a child-owned lock');
  child.kill('SIGSTOP');
  assert.equal(await acquireMaintenanceLock(root), null, 'a paused owner is not expired ownership');
  child.kill('SIGKILL');
  await closed;
  const replacement = await acquireMaintenanceLock(root);
  assert.ok(replacement);
  await replacement.close();
  assert.equal((await fs.readdir(root)).includes('housekeeping.lock'), true, 'lock inode must remain persistent');
});

test('symlinked lock paths cannot redirect ownership', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-housekeeping-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'other'), '');
  await fs.symlink(path.join(root, 'other'), path.join(root, 'housekeeping.lock'));
  await assert.rejects(acquireMaintenanceLock(root));
});

test('simultaneous acquisitions produce exactly one kernel owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-housekeeping-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireMaintenanceLock(root)));
  const owners = attempts.filter(Boolean);
  assert.equal(owners.length, 1);
  await owners[0].close();
});

test('an ownership environment flag and an unrelated open descriptor cannot bypass the kernel owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-housekeeping-'));
  const owner = await acquireMaintenanceLock(root);
  const unrelated = await fs.open(path.join(root, 'housekeeping.lock'), 'r+');
  t.after(async () => {
    await unrelated.close();
    await owner.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./maintenance-lock-inherit.mjs', import.meta.url)),
      '-e',
      'console.log("unsafe")',
    ],
    {
      env: { ...process.env, RIVET_LEGACY_RESTORE_ROOT: root, RIVET_MAINTENANCE_LOCK_INHERITED: '1' },
      stdio: ['ignore', 'pipe', 'pipe', unrelated.fd],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const exit = await new Promise((resolve) => child.once('close', resolve));
  assert.notEqual(exit, 0);
  assert.equal(output.includes('unsafe'), false);
  assert.equal(await acquireMaintenanceLock(root), null);
});

test('spawned grandchildren keep the lock even after their Node parent is killed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-housekeeping-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lease = await acquireMaintenanceLock(root);
  const preload = fileURLToPath(new URL('./maintenance-lock-inherit.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      '-e',
      'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)',
    ],
    {
      env: {
        ...process.env,
        RIVET_LEGACY_RESTORE_ROOT: root,
        RIVET_MAINTENANCE_LOCK_INHERITED: '1',
        NODE_OPTIONS: `--import=${preload}`,
      },
      stdio: ['ignore', 'pipe', 'inherit', lease.fd],
    },
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  const grandchild = await new Promise((resolve) =>
    child.stdout.once('data', (data) => resolve(Number(String(data).trim()))),
  );
  t.after(() => {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {}
  });
  await lease.close();
  child.kill('SIGKILL');
  await closed;
  assert.equal(await acquireMaintenanceLock(root), null, 'orphan child must retain kernel fencing');
  process.kill(grandchild, 'SIGKILL');
  let next;
  for (let i = 0; i < 50 && !next; i++) {
    next = await acquireMaintenanceLock(root);
    if (!next) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(next);
  await next.close();
});

test('sanitized maintenance child environments preserve the lock root and their own Node options', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sanitized-owner-'));
  const lease = await acquireMaintenanceLock(root);
  t.after(async () => {
    await lease.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const preload = fileURLToPath(new URL('./maintenance-lock-inherit.mjs', import.meta.url));
  const script = `const {spawnSync}=require('node:child_process');
    const result=spawnSync(process.execPath,['-e',
      'console.log(JSON.stringify({owner:globalThis[Symbol.for("rivet.housekeeping.kernel-owner")],limit:Error.stackTraceLimit,root:process.env.RIVET_LEGACY_RESTORE_ROOT}))'
    ],{env:{NODE_OPTIONS:'--stack-trace-limit=27',RIVET_LEGACY_RESTORE_ROOT:'/incorrect-root'}});
    process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status??1;`;
  const child = spawn(process.execPath, ['--import', preload, '-e', script], {
    env: {
      ...process.env,
      RIVET_LEGACY_RESTORE_ROOT: root,
      RIVET_MAINTENANCE_LOCK_INHERITED: '1',
      NODE_OPTIONS: `--import=${preload}`,
    },
    stdio: ['ignore', 'pipe', 'pipe', lease.fd],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  assert.equal(await new Promise((resolve) => child.once('close', resolve)), 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { owner: true, limit: 27, root });
});
