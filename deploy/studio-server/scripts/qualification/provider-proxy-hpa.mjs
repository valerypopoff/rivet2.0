import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { role, ready, until } from './provider-gate.mjs';
import { proxyFixtureProcessCommand } from '../lib/staging-proxy-fixture-process.mjs';
import { continuityTimeoutMs } from '../lib/request-continuity.mjs';
import { isGkeProxyBackendReady } from '../lib/gke-proxy-health.mjs';
export function processStartTicks(stat) {
  const end = stat.lastIndexOf(')');
  assert.ok(end > 0);
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  assert.ok(fields.length >= 20);
  assert.match(fields[19], /^\d+$/);
  return fields[19];
}
const script = `set -eu
marker="$1"; stop="$2"; uid="$3"
test ! -e "$marker"; test ! -e "$stop"
ticks=$(awk '{print $22}' /proc/$$/stat)
printf '{"pid":%s,"startTicks":"%s","podUid":"%s"}\n' "$$" "$ticks" "$uid" > "$marker"
end=$(( $(date +%s) + 600 ))
while [ ! -e "$stop" ] && [ "$(date +%s)" -lt "$end" ]; do
 i=0; while [ "$i" -lt 10000 ]; do i=$((i+1)); done
done
printf '{"stopped":true,"pid":%s,"startTicks":"%s","podUid":"%s"}\n' "$$" "$ticks" "$uid"
`;
export async function observeHpaContinuity(
  probes,
  { pressureStoppedAt, proxies, readProxies, hpaUid, now = Date.now },
) {
  if (!probes) return;
  const observedAt = now();
  const departing = proxies.filter((p) => p.metadata.deletionTimestamp);
  if (!probes.cohorts.has('hpa-removal') && observedAt - Date.parse(pressureStoppedAt) >= 240000) {
    assert.equal(departing.length, 0, 'HPA removed a proxy before protected requests were admitted');
    await probes.startCohort('hpa-removal');
    const confirmed = await readProxies();
    assert.ok(
      proxies.every((p) => confirmed.some((c) => c.metadata.uid === p.metadata.uid && !c.metadata.deletionTimestamp)),
      'HPA withdrawal raced protected request admission',
    );
    probes.hpaAdmissionConfirmedAt = new Date(now()).toISOString();
  }
  if (departing.length && !probes.removal) {
    assert.ok(probes.cohorts.has('hpa-removal'), 'No protected requests preceded HPA removal');
    probes.removal = {
      hpaUid,
      admissionConfirmedAt: probes.hpaAdmissionConfirmedAt,
      observedAt: new Date(observedAt).toISOString(),
      podUids: departing.map((p) => p.metadata.uid),
    };
  }
}
export async function runProviderProxyHpa(gate, owned) {
  assert.equal(gate.controllerEnabled, true);
  assert.equal(gate.profile, 'compact');
  assert.equal(gate.singleton, true);
  const name = gate.config.release + '-proxy',
    proxies = async () => (await gate.pods()).filter((p) => role(p) === 'proxy');
  const original = await proxies();
  assert.equal(original.length, 2);
  assert.ok(original.every(ready));
  await gate.frontendAvailability();
  const hpa = JSON.parse((await gate.kube(['get', 'hpa', name, '-o', 'json'])).stdout);
  assert.equal(hpa.spec.minReplicas, 2);
  assert.equal(hpa.spec.maxReplicas, 4);
  assert.equal(hpa.spec.metrics[0].resource.target.averageUtilization, 75);
  assert.equal(hpa.spec.behavior.scaleDown.stabilizationWindowSeconds, 300);
  const report = {
    startedAt: new Date().toISOString(),
    source: gate.manifest.source.sha,
    hpaUid: hpa.metadata.uid,
    pressureKind: 'bounded-staging-CPU-fixture-with-independent-live-public-traffic',
    throughputQualification: false,
    manuallyChangedReplicas: false,
    developerReplicasUnchanged: true,
    processes: [],
  };
  const running = [];
  try {
    for (const pod of original) {
      const nonce = randomUUID(),
        marker = '/tmp/rivet-hpa-load-' + nonce + '.json',
        stop = '/tmp/rivet-hpa-stop-' + nonce;
      const item = {
        pod: pod.metadata.name,
        uid: pod.metadata.uid,
        marker,
        stop,
        dispatchedAt: new Date().toISOString(),
        maximumSeconds: 600,
      };
      report.processes.push(item);
      await gate.artifact('hpa-load-' + nonce + '-intent.json', JSON.stringify(item));
      item.journalId = await owned.processIntent(item);
      const completed = gate
        .kube([
          'exec',
          pod.metadata.name,
          '-c',
          'proxy',
          '--',
          'sh',
          '-ec',
          script,
          'rivet-hpa-fixture',
          marker,
          stop,
          pod.metadata.uid,
        ])
        .then((result) => {
          const value = JSON.parse(result.stdout.trim().split('\n').at(-1));
          assert.equal(value.stopped, true);
          assert.equal(value.podUid, pod.metadata.uid);
          item.finishedAt = new Date().toISOString();
          return value;
        });
      completed.catch(() => {});
      running.push({ item, completed });
      const identity = await until(
        'bounded CPU fixture process identity',
        async () => {
          const result = await gate.kube([
            'exec',
            pod.metadata.name,
            '-c',
            'proxy',
            '--',
            'sh',
            '-ec',
            'if [ -r "$1" ]; then cat "$1"; fi',
            'read-fixture',
            marker,
          ]);
          return result.stdout.trim() ? JSON.parse(result.stdout) : null;
        },
        30000,
      );
      assert.equal(identity.podUid, pod.metadata.uid);
      assert.ok(Number.isInteger(identity.pid) && identity.pid > 1);
      assert.match(identity.startTicks, /^\d+$/);
      Object.assign(item, identity);
      await owned.processIdentity(item.journalId, identity);
    }
    const started = Date.now();
    await until(
      'real HPA decision and four actual healthy proxy endpoints',
      async () => {
        const current = JSON.parse((await gate.kube(['get', 'hpa', name, '-o', 'json'])).stdout);
        assert.equal(current.metadata.uid, hpa.metadata.uid);
        const pods = await proxies();
        assert.ok(pods.length <= 5, 'HPA plus one legal rollout surge exceeded bounds');
        if (
          current.status.desiredReplicas !== 4 ||
          current.status.currentReplicas !== 4 ||
          pods.length !== 4 ||
          !pods.every(ready)
        )
          return false;
        const service = JSON.parse((await gate.kube(['get', 'service', name, '-o', 'json'])).stdout);
        const backend = await gate.observeProxyBackend(service, { allowPending: true });
        if (!isGkeProxyBackendReady(pods, service, backend)) return false;
        report.scaleUpObservation = {
          at: new Date().toISOString(),
          elapsedMs: Date.now() - started,
          desired: current.status.desiredReplicas,
          readyUids: pods.map((p) => p.metadata.uid),
          metrics: current.status.currentMetrics,
          backend,
        };
        return true;
      },
      540000,
    );
  } finally {
    // Stop only our nonce-named fixture after checking precise process identity.
    // No generic kill, pod retirement, replica patch or HPA policy change.
    for (const { item } of running) {
      if (!item.pid || item.finishedAt) continue;
      const pod = (await proxies()).find((p) => p.metadata.uid === item.uid);
      if (!pod) continue; // Its process cannot survive that exact Pod UID.
      await gate.kube(['exec', item.pod, '-c', 'proxy', '--', ...proxyFixtureProcessCommand(item, { stop: true })]);
    }
    const settled = await Promise.allSettled(running.map((v) => v.completed));
    assert.ok(
      settled.every((v) => v.status === 'fulfilled'),
      'bounded CPU fixture failed or was interrupted',
    );
    for (const { item } of running) await owned.processSettled(item.journalId);
  }
  report.pressureStoppedAt = new Date().toISOString();
  await until(
    'real full-window HPA automatic return to compact two-proxy baseline',
    async () => {
      const actual = JSON.parse((await gate.kube(['get', 'hpa', name, '-o', 'json'])).stdout);
      assert.equal(actual.metadata.uid, hpa.metadata.uid);
      const current = await proxies();
      // The real HPA retains high recommendations for 300 seconds. Admit the
      // protected cohort late in that window, before any observed withdrawal.
      // Missing the window fails; requests begun on survivors cannot prove drain.
      await observeHpaContinuity(gate.continuityProbes, {
        pressureStoppedAt: report.pressureStoppedAt,
        proxies: current,
        readProxies: proxies,
        hpaUid: hpa.metadata.uid,
      });
      return actual.status.desiredReplicas === 2 && current.length === 2 && current.every(ready);
    },
    gate.operation?.requestContinuityProfile
      ? continuityTimeoutMs(gate.operation.requestContinuityProfile) +
          hpa.spec.behavior.scaleDown.stabilizationWindowSeconds * 1000
      : 1200000,
  );
  await gate.frontendAvailability();
  const developers = (await gate.pods()).filter((p) => ['web', 'backend'].includes(role(p)));
  assert.equal(developers.length, 2);
  assert.ok(developers.every(ready));
  report.finishedAt = new Date().toISOString();
  return report;
}
