import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// test-style: fixture-read: Inspect only private diagnostic files from disposable child processes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyOfflineTemporaryActor, verifyTemporaryActorExport } from './lib/temporary-staging-actor.mjs';
import { temporaryHash } from './lib/temporary-staging-contract.mjs';

const fixture = fileURLToPath(new URL('./fixtures/temporary-actor-preflight-tool.mjs', import.meta.url));

test('terminal actor export validates exact bytes and bounds without treating omitted large diagnostics as missing receipts', () => {
  const file = { name: 'results/terminal.json', bytes: 'e30=', hash: temporaryHash('{}') };
  const value = { files: [file, { name: 'results/trace.zip', size: 50000000, omitted: 'bounded-diagnostics' }] };
  assert.equal(verifyTemporaryActorExport(value), value);
  for (const files of [
    [],
    [file, file],
    [{ ...file, hash: 'f'.repeat(64) }],
    [{ ...file, bytes: 'e30=!' }],
    [{ ...file, name: '../terminal.json' }],
    [{ ...file, name: '/terminal.json' }],
    [{ ...file, name: 'results\\terminal.json' }],
    [{ name: 'large.bin', size: -1, omitted: 'bounded-diagnostics' }],
    [{ ...file, bytes: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }],
  ])
    assert.throws(() => verifyTemporaryActorExport({ files }));
});
test('offline actor input, identity, bounded output and physical process completion are mandatory', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-preflight-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plan = { actorImage: 'fixture/image', actorSourceRoot: '/app', sourceSha: 'a'.repeat(40) };
  for (const mode of [
    'ok',
    'wrong-source',
    'bad-json',
    'overflow',
    'early-close',
    'failed-late',
    'hang',
    'missing-command',
  ])
    await t.test(mode, async () => {
      let closed = false;
      const diagnosticFile = path.join(directory, mode + '.json');
      const result = verifyOfflineTemporaryActor(plan, {
        diagnosticFile,
        timeoutMs: mode === 'hang' ? 100 : 5000,
        spawnImpl: (program, args, options) => {
          assert.equal(program, 'docker');
          const child =
            mode === 'missing-command'
              ? spawn('rivet-offline-fixture-command-does-not-exist', [], options)
              : spawn(process.execPath, [fixture, mode, ...args], options);
          child.on('close', () => {
            closed = true;
          });
          return child;
        },
      });
      if (mode === 'ok') assert.equal((await result).sourceSha, plan.sourceSha);
      else await assert.rejects(result, /Offline actor/);
      assert.equal(closed, true, 'A receipt or process error cannot imply physical completion');
      if (mode === 'ok') await assert.rejects(fs.stat(diagnosticFile), { code: 'ENOENT' });
      else {
        const details = JSON.parse(await fs.readFile(diagnosticFile, 'utf8'));
        if (mode === 'failed-late') {
          assert.equal(details.exitCode, 7);
          assert.match(details.failure.error.message, /code 7/);
          assert.equal(details.stderr, 'private fixture media-tool failure');
        }
        assert.ok(details.stderr.length <= 65536);
      }
    });
});

test('private preflight diagnostic failure cannot overwrite retained evidence or hide the original exit', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-preflight-retained-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const diagnosticFile = path.join(directory, 'retained.json');
  await fs.writeFile(diagnosticFile, 'original private evidence', { flag: 'wx' });
  await assert.rejects(
    verifyOfflineTemporaryActor(
      { actorImage: 'fixture/image', actorSourceRoot: '/app', sourceSha: 'a'.repeat(40) },
      {
        diagnosticFile,
        spawnImpl: (_program, args, options) => spawn(process.execPath, [fixture, 'failed-late', ...args], options),
      },
    ),
    (error) => {
      assert.ok(error.cause instanceof AggregateError);
      assert.match(error.cause.errors[0].message, /code 7/);
      assert.equal(error.cause.errors[1].code, 'EEXIST');
      return true;
    },
  );
  assert.equal(await fs.readFile(diagnosticFile, 'utf8'), 'original private evidence');
});
