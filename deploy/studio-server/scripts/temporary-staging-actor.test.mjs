import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
      const result = verifyOfflineTemporaryActor(plan, {
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
    });
});
