import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalUpgradePreparationJobs, waitForLocalUpgradeDrain } from '../local-metadata/preparation-jobs.js';

test('guided preparation waits for active work and checks ownership around each drain snapshot', async () => {
  const events: string[] = [];
  let reads = 0;
  await waitForLocalUpgradeDrain(
    async () => {
      events.push('read');
      return { ready: ++reads === 2 };
    },
    async () => {
      events.push('check');
    },
  );
  assert.deepEqual(events, ['check', 'read', 'check', 'check', 'read', 'check']);
});

test('expired drain admission never reads or accepts an already quiet source', async () => {
  let reads = 0;
  await assert.rejects(
    waitForLocalUpgradeDrain(
      async () => {
        reads++;
        return { ready: true };
      },
      async () => {},
      0,
    ),
    /Timed out/,
  );
  assert.equal(reads, 0);
});

test('a quiet drain result arriving at or after the deadline cannot authorize backup', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const events: string[] = [];
  for (const elapsed of [10, 11]) {
    clock = 0;
    events.length = 0;
    await assert.rejects(
      waitForLocalUpgradeDrain(
        async () => {
          events.push('read');
          clock = elapsed;
          return { ready: true };
        },
        async () => {
          events.push('check');
        },
        10,
      ),
      /Timed out/,
    );
    assert.deepEqual(events, ['check', 'read', 'check']);
  }
});

test('ownership checks consume the drain budget before another snapshot starts', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  let reads = 0;
  await assert.rejects(
    waitForLocalUpgradeDrain(
      async () => {
        reads++;
        return { ready: true };
      },
      async () => {
        clock = 10;
      },
      10,
    ),
    /Timed out/,
  );
  assert.equal(reads, 0);
});

test('lost ownership prevents even the first drain read', async () => {
  let reads = 0;
  await assert.rejects(
    waitForLocalUpgradeDrain(
      async () => {
        reads++;
        return { ready: true };
      },
      async () => {
        throw new Error('Owner changed');
      },
    ),
    /Owner changed/,
  );
  assert.equal(reads, 0);
});

test('a transition or maintenance change during a quiet snapshot cannot authorize backup', async () => {
  let current = true;
  await assert.rejects(
    waitForLocalUpgradeDrain(
      async () => {
        current = false;
        return { ready: true };
      },
      async () => {
        if (!current) throw new Error('Owner changed');
      },
    ),
    /Owner changed/,
  );
});

test('an unreadable drain snapshot fails rather than being interpreted as a quiet source', async () => {
  await assert.rejects(
    waitForLocalUpgradeDrain(
      async () => {
        throw new Error('Snapshot unavailable');
      },
      async () => {},
    ),
    /Snapshot unavailable/,
  );
});

test('drain deadline retains actionable failure, never pause-only success or backup admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-drain-deadline-'));
  const jobs = new LocalUpgradePreparationJobs(root);
  const id = randomUUID();
  let backups = 0;
  try {
    await jobs.start({ id, kind: 'pause-backup', revision: 1 }, async (_job, stage) => {
      await stage('pause');
      await waitForLocalUpgradeDrain(
        async () => ({ ready: false }),
        async () => {},
        20,
      );
      await stage('backup');
      backups++;
    });
    await jobs.settled();
    const result = await jobs.status();
    assert.equal(result?.phase, 'failed');
    assert.equal(result?.stage, 'pause');
    assert.match(result?.error ?? '', /Timed out.*Writes remain paused.*Create verified backup/);
    assert.equal(backups, 0);
    assert.deepEqual(await new LocalUpgradePreparationJobs(root).status(), result);
    const replay = await jobs.start({ id, kind: 'pause-backup', revision: 1 }, async () => {
      backups++;
    });
    assert.equal(replay.phase, 'failed');
    assert.equal(backups, 0);
    // A timeout releases admission. A deliberate new request can complete;
    // neither the old error nor the old identity must poison that retry.
    const retryId = randomUUID();
    await jobs.start({ id: retryId, kind: 'pause-backup', revision: 1 }, async (_job, stage) => {
      await stage('pause');
      await waitForLocalUpgradeDrain(
        async () => ({ ready: true }),
        async () => {},
      );
      await stage('backup');
      backups++;
    });
    await jobs.settled();
    const retry = await jobs.status();
    assert.equal(retry?.id, retryId);
    assert.equal(retry?.phase, 'ready');
    assert.equal(retry?.stage, 'backup');
    assert.equal(retry?.error, undefined);
    assert.equal(backups, 1);
  } finally {
    await jobs.settled();
    await fs.rm(root, { recursive: true, force: true });
  }
});
