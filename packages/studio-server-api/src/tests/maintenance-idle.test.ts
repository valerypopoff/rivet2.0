import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectBundleJobs } from '../routes/workflows/project-bundle-jobs.js';

// test-style: fixture-read: Verify the synthetic unfinished journal is unchanged by read-only idle inspection.

test('bridge idle inspection preserves ambiguous bundle journals and never initializes recovery scratch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-maintenance-idle-'));
  try {
    const scratch = path.join(root, 'scratch'),
      jobs = new ProjectBundleJobs(scratch);
    await jobs.assertMayTransfer();
    await assert.rejects(fs.stat(scratch), { code: 'ENOENT' });
    const id = randomUUID(),
      directory = path.join(scratch, id),
      journal = path.join(directory, 'status.json');
    await fs.mkdir(directory, { recursive: true });
    for (const phase of ['collecting', 'packaging', 'unknown']) {
      const bytes = JSON.stringify({ id, phase });
      await fs.writeFile(journal, bytes);
      await assert.rejects(jobs.assertMayTransfer(), /Unfinished bundle journal/);
      assert.equal(
        await fs.readFile(journal, 'utf8'),
        bytes,
        'inspection must not convert a predecessor job to interrupted',
      );
    }
    await fs.writeFile(journal, JSON.stringify({ id, phase: 'ready' }));
    await jobs.assertMayTransfer();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
