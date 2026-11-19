import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runDeploymentOperation } from './deployment-operation.mjs';
import { requireDeploymentSafety } from './deployment-safety.mjs';
import { assertHaRetirement } from './ha-rolling-upgrade.mjs';

const delay = () => new Promise((resolve) => setTimeout(resolve, 500));
const sameProcess = (owner, pod, status) =>
  !!owner && owner.uid === pod?.uid && owner.incarnation === status?.incarnation;
const standbyTemplates = ['bootstrap', 'fenced', 'final'];

/** First adoption uses the same lease and retirement handshake as a normal roll.
 * The old -0 still owns inline maintenance, so the locked worker starts only
 * after its exact Pod has terminated. */
export async function runOnlineEditorAdoption({
  identity,
  safety,
  readJournal,
  saveJournal,
  resumeToken,
  abort = false,
  preflight,
  acquireRestoreGuard,
  observe,
  setRoute,
  setTemplate,
  setReplicas,
  setAdmission,
  status,
  withdraw,
  begin,
  waitForWithdrawal,
  remove,
  accept,
  observeTraffic,
  verify,
  timeoutMs,
  now = Date.now,
  wait = delay,
  uuid = randomUUID,
}) {
  requireDeploymentSafety(safety, 'topology', identity);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  verify = safety.requireSettlement(verify);
  identity = safety.bind({ ...identity, onlineEditorAdoption: 1 });
  const record = await readJournal();
  const recovering = !!record && record.phase !== 'complete';
  if (recovering) {
    assert.equal(record.token, resumeToken, 'Resume the exact editor adoption journal');
    assert.ok(Object.keys(identity).every((key) => isDeepStrictEqual(identity[key], record[key])));
  } else {
    assert.ok(!resumeToken && !abort, 'No unfinished editor adoption matches this token');
    await preflight();
  }
  const runner = uuid();
  return runDeploymentOperation({
    name: 'Online editor adoption',
    record,
    initial: recovering
      ? undefined
      : { protocol: 1, ...identity, phase: 'owners', token: uuid(), steps: [], pending: null },
    runner,
    resumeToken,
    safety,
    readJournal,
    saveJournal,
    now,
    onFailure: async (_error, op) => {
      if (!recovering && !op.record.pending && !op.record.steps.length && !op.failure)
        await op.complete({ abortedBeforeTopologyChanges: true });
    },
    run: async (op) => {
      await safety.checkOwnedBaseline(op.record, runner, now);
      const guard = await acquireRestoreGuard();
      try {
        const until = async (check, error) => {
          const deadline = now() + timeoutMs;
          do {
            op.assertLease();
            const result = await check();
            if (result) return result;
            await wait();
          } while (now() < deadline);
          throw Error(error);
        };
        const checkGuard = async () => {
          op.assertLease();
          await guard.check();
          op.assertLease();
        };
        const check = async (stage, owner) => {
          await checkGuard();
          await observeTraffic(stage, owner);
          await checkGuard();
        };
        const step = async (name, run) => {
          if (op.record.steps.includes(name)) return;
          assert.ok(!op.record.pending || op.record.pending === name, 'An editor adoption write is unresolved');
          if (!op.record.pending) await op.checkpoint({ pending: name });
          await check(name);
          await run();
          await op.checkpoint({ steps: [...op.record.steps, name], pending: null });
        };
        const inspect = async (ordinal) => {
          const pod = await observe(ordinal);
          if (!pod || pod.terminating) return null;
          return { pod, state: assertHaRetirement(await status(pod)) };
        };
        const isServing = (current, housekeeping) =>
          current?.pod.ready &&
          current.state.state === 'serving' &&
          !current.state.operationId &&
          (!housekeeping ||
            (current.state.housekeeping?.state === housekeeping &&
              current.state.housekeeping.podUid === current.pod.uid &&
              current.state.housekeeping.incarnation === current.state.incarnation));
        const serving = async (ordinal, templates, housekeeping) => {
          const { pod, state } = await until(
            async () => {
              const pod = await observe(ordinal);
              if (!pod?.ready || !(await pod.isTemplate(...templates))) return null;
              const current = await inspect(ordinal);
              return current?.pod.uid === pod.uid && isServing(current, housekeeping) ? current : null;
            },
            `Editor -${ordinal} did not become a serving ${templates.join('/')} process`,
          );
          return { ...pod, incarnation: state.incarnation, housekeeping };
        };
        const confirmRouted = async (owner, stage = 'routed-editor') => {
          await check(stage, owner);
          const current = await inspect(owner.ordinal);
          assert.ok(
            isServing(current, owner.housekeeping) && sameProcess(owner, current?.pod, current?.state),
            'The verified serving editor changed',
          );
          return owner;
        };
        const bind = async (key, pod) => {
          if (!sameProcess(op.record[key], pod, pod)) {
            await op.checkpoint({
              [key]: {
                name: pod.name,
                uid: pod.uid,
                incarnation: pod.incarnation,
                ordinal: pod.ordinal,
                operationId: uuid(),
              },
            });
          }
          return op.record[key];
        };
        const admit = async (key, pod, label = true) => {
          if (!sameProcess(op.record[key], pod, pod)) {
            await checkGuard();
            await accept(pod);
            await bind(key, pod);
          }
          if (label && !pod.hasAdmission(op.record.token)) {
            await checkGuard();
            await setAdmission(pod, op.record.token, op.record.token);
          }
          return pod;
        };
        const standby = async () =>
          confirmRouted(await admit('standby', await serving(1, standbyTemplates, 'standby')));
        const final = async ({ label = true, stage } = {}) =>
          confirmRouted(await admit('final', await serving(0, ['final'], 'owner'), label), stage);
        const source = () => serving(0, ['source', 'bootstrap']);
        const routedSource = async () => confirmRouted(await source());
        const beforeWithdrawal = (prefix) =>
          !op.record.steps.includes(`${prefix}-withdraw`) && op.record.pending !== `${prefix}-withdraw`;

        const drain = async (prefix, owner, protect, { last = 'replace' } = {}) => {
          const current = async () => {
            const observed = await inspect(owner.ordinal);
            assert.ok(observed && sameProcess(owner, observed.pod, observed.state), 'The draining editor changed');
            assert.ok(!observed.state.operationId || observed.state.operationId === owner.operationId);
            return observed;
          };
          await step(`${prefix}-withdraw`, async () => {
            await protect();
            const { pod, state } = await current();
            await checkGuard();
            await setAdmission(pod, null, op.record.token);
            await checkGuard();
            if (!state.operationId) await withdraw(pod, owner.operationId, owner.incarnation);
            await until(async () => {
              const { state: observed } = await current();
              return (
                observed.operationId === owner.operationId &&
                ['withdrawing', 'draining', 'drained'].includes(observed.state)
              );
            }, 'Editor withdrawal was not acknowledged');
          });
          await step(`${prefix}-drain`, async () => {
            const replacement = await protect();
            const { pod } = await current();
            await waitForWithdrawal(pod, replacement, checkGuard);
            const routedEditor = await protect();
            const { state } = await current();
            if (state.state === 'withdrawing') {
              await checkGuard();
              await begin(pod, owner.operationId, owner.incarnation);
            }
            await check(`${prefix}-withdrawn`, routedEditor);
            await until(
              async () => (await current()).state.state === 'drained',
              'Accepted editor or maintenance work has not finished',
            );
          });
          await step(`${prefix}-${last}`, async () => {
            await protect();
            const pod = await observe(owner.ordinal);
            if (pod?.uid === owner.uid && !pod.terminating) {
              const { pod: currentPod, state } = await current();
              assert.equal(state.state, 'drained');
              assert.equal(state.operationId, owner.operationId);
              await checkGuard();
              if (last === 'scale-down') await setReplicas(1, { ...currentPod, ...owner });
              else await remove(currentPod);
            } else if (last === 'scale-down') {
              await checkGuard();
              await setReplicas(1, null, { verifyOnly: true });
            } else if (pod && pod.uid !== owner.uid) {
              assert.ok(await pod.isTemplate('fenced'), 'The departing editor vanished without a fenced successor');
            }
            await until(async () => {
              const currentPod = await observe(owner.ordinal);
              return last === 'scale-down' ? !currentPod : currentPod?.uid !== owner.uid;
            }, 'The retired editor has not terminated');
          });
        };
        if (abort || op.record.aborting) {
          assert.ok(abort, 'Continue the exact abort with --abort-online-adoption');
          assert.ok(
            !op.record.steps.includes('source-withdraw') &&
              !['source-withdraw', 'source-drain', 'source-replace'].includes(op.record.pending),
            'Source withdrawal has started; resume the handoff instead',
          );
          if (!op.record.aborting) {
            await op.checkpoint({ aborting: true, pending: null, mayHaveAdmitted: !!op.record.standby });
          }
          if (op.record.mayHaveAdmitted) {
            await step('abort-source-restart', async () => {
              await setTemplate('bootstrap', { undoFence: true });
              const pod = await observe(0);
              if (pod && !pod.terminating && (await pod.isTemplate('fenced'))) {
                assert.ok(!pod.admitted && !pod.ready, 'Startup-fenced editor may have admitted work');
                await standby();
                await checkGuard();
                await remove(pod);
              }
            });
          }
          await step('abort-source-route', async () => {
            const old = await source();
            await checkGuard();
            await setRoute('source', op.record.token, old);
            await confirmRouted(old, 'abort-source-routed');
          });
          if (op.record.mayHaveAdmitted && beforeWithdrawal('abort-standby'))
            await bind('abortStandby', await serving(1, standbyTemplates, 'standby'));
          if (op.record.abortStandby) {
            await drain('abort-standby', op.record.abortStandby, routedSource, { last: 'scale-down' });
          } else {
            await step('abort-unadmitted', async () => {
              await routedSource();
              await checkGuard();
              await setReplicas(1);
            });
          }
          await until(async () => !(await observe(1)), 'Standby has not settled during abort');
          // The original template starts inline maintenance on any ordinal.
          await step('abort-template', () => setTemplate('source'));
          await step('abort-routes', async () => {
            const old = await routedSource();
            await checkGuard();
            await setRoute('normal', op.record.token, old);
            await confirmRouted(old);
            await setAdmission(old, null, op.record.token);
          });
          await check('aborted');
          await op.complete({ abortedBeforeTopologyChanges: true });
          return;
        }

        // Repair a serving replacement before the next routed probe on resume.
        // A departing process keeps its original binding once withdrawal starts.
        if (recovering) {
          if (op.record.final) await final({ label: !op.record.steps.includes('restore-routes') });
          else if (op.record.steps.includes('admit-standby')) await standby();
          else if (op.record.standby) await admit('standby', await serving(1, ['bootstrap'], 'standby'));
        }
        await step('source-route', async () => {
          const old = await routedSource();
          await checkGuard();
          await setRoute('source', op.record.token, old);
          await confirmRouted(old, 'source-routed');
        });
        await step('bootstrap-template', async () => {
          await routedSource();
          await checkGuard();
          await setTemplate('bootstrap');
        });
        await step('scale-up', async () => {
          await routedSource();
          await checkGuard();
          await setReplicas(2);
        });
        await step('admit-standby', async () => {
          const candidate = await admit('standby', await serving(1, ['bootstrap'], 'standby'));
          const old = await source();
          await checkGuard();
          await setAdmission(old, op.record.token, op.record.token);
          await checkGuard();
          await setRoute('overlap', op.record.token, old);
          await confirmRouted(candidate, 'standby-routed');
        });
        await step('fence-source', async () => {
          await standby();
          await checkGuard();
          await setTemplate('fenced');
        });
        if (beforeWithdrawal('source')) await bind('source', await source());
        await drain('source', op.record.source, standby);
        await step('final-template', async () => {
          await standby();
          await checkGuard();
          await setTemplate('final');
        });
        await step('replace-fenced-pod', async () => {
          const pod = await observe(0);
          if (!pod || (await pod.isTemplate('final')) || pod.terminating) return;
          assert.ok(await pod.isTemplate('fenced'), 'Unexpected ordinal 0 after legacy termination');
          assert.equal(pod.admitted, false);
          await standby();
          await checkGuard();
          await remove(pod);
        });
        await step('admit-final', async () => {
          const candidate = await admit('final', await serving(0, ['final'], 'owner'));
          await confirmRouted(candidate, 'final-routed');
        });
        if (beforeWithdrawal('standby')) await bind('standby', await serving(1, standbyTemplates, 'standby'));
        await drain('standby', op.record.standby, final, { last: 'scale-down' });
        await step('restore-routes', async () => {
          const target = await final();
          await checkGuard();
          await setRoute('normal', op.record.token, target);
          await confirmRouted(target);
          await setAdmission(target, null, op.record.token);
        });
        const target = await final({ label: false, stage: 'final-settlement' });
        safety.confirmSettlement(await verify(op, () => confirmRouted(target, 'settlement-write')));
        await final({ label: false, stage: 'settled' });
        await op.complete();
      } finally {
        await guard.close();
      }
    },
  });
}
