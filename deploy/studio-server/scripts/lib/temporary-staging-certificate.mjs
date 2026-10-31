import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Resolver } from 'node:dns/promises';
import { temporaryAdmission, temporaryHash, assertTemporaryCertificate } from './temporary-staging-contract.mjs';

const directoryUrl = 'https://acme-v02.api.letsencrypt.org/directory';
const execute = promisify(execFile);
const dockerCommand = async (args) =>
  (await execute('docker', args, { timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true })).stdout;

/** Only read-only readiness probes may wait through these transport failures.
 * A redirect, programming error or contradictory DNS identity must fail closed. */
export function transientTemporaryChallengeError(error) {
  return (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    [
      'ENOTFOUND',
      'ENODATA',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(error?.cause?.code ?? error?.code)
  );
}

async function responseText(response, limit) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      assert.ok(bytes <= limit, 'Oversized certificate-service response');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString();
  } finally {
    await reader.cancel();
  }
}

export async function verifyTemporaryChallenge(
  { hostname, address, token, validation },
  { resolve = (name) => new Resolver({ timeout: 3000, tries: 2 }).resolve4(name), fetchImpl = fetch } = {},
) {
  const addresses = await resolve(hostname);
  assert.ok(
    addresses.length && addresses.every((ip) => ip === address),
    'Staging hostname does not resolve exclusively to the owned address',
  );
  const response = await fetchImpl(`http://${hostname}/.well-known/acme-challenge/${token}`, {
    redirect: 'error',
    headers: { Connection: 'close' },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  return (await responseText(response, 2048)) === validation;
}

// This hook has no Kubernetes/cloud credentials. The parent publishes only the
// exact challenge and releases it after checking its public HTTP response.
export const temporaryAcmeHook = `import os,json,time,hashlib
from pathlib import Path
root=Path('/exchange')
policy=json.loads((root/'policy.json').read_text())
assert os.environ.get('CERTBOT_IDENTIFIER',os.environ.get('CERTBOT_DOMAIN'))==policy['hostname']
assert os.environ.get('CERTBOT_REMAINING_CHALLENGES','0')=='0'
packet={'token':os.environ['CERTBOT_TOKEN'],'validation':os.environ['CERTBOT_VALIDATION']}
data=json.dumps(packet,separators=(',',':')).encode()
with (root/'challenge.tmp').open('xb') as f:
 f.write(data); f.flush(); os.fsync(f.fileno())
os.rename(root/'challenge.tmp',root/'challenge.json')
expected=hashlib.sha256(data).hexdigest()
while time.time()*1000<policy['deadline']:
 try:
  if (root/'verified').read_text()==expected: break
 except FileNotFoundError: pass
 time.sleep(1)
else: raise RuntimeError('Challenge admission expired')
`;

async function inspectWorker(store, docker) {
  const { record } = await store.read(),
    worker = record.certificateWorker;
  if (!worker || worker.removed) return null;
  const ids = (
    await docker([
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `name=^/${worker.name}$`,
      '--format',
      '{{.ID}}',
    ])
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!ids.length) {
    assert.ok(worker.removeIssued && worker.identity, 'Certificate worker creation/removal remains uncertain');
    return null;
  }
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^[a-f0-9]{64}$/);
  const rows = JSON.parse(await docker(['inspect', ids[0]]));
  assert.equal(rows.length, 1);
  const actual = rows[0];
  assert.equal(actual.Id, ids[0]);
  assert.equal(actual.Name, '/' + worker.name);
  assert.equal(actual.Config.Image, record.plan.acme.image);
  assert.equal(actual.Config.Labels['rivet.temporary-certificate'], record.plan.inputHash);
  const identity = { id: actual.Id, imageId: actual.Image, created: actual.Created };
  if (worker.identity) assert.deepEqual(identity, worker.identity, 'Certificate worker was replaced');
  else {
    assert.ok(worker.createIssued && worker.absenceVerified);
    await store.change((r) => {
      r.certificateWorker.identity = identity;
    });
  }
  return actual;
}

/** Settle/remove only the precise operation-owned local worker. Never issue a
 * second account/order, force-kill a paused worker or erase private evidence. */
export async function settleTemporaryCertificate(store, { wait, stop = false, docker = dockerCommand } = {}) {
  const { record } = await store.read();
  if (!record.certificateWorker || record.certificateWorker.removed) return;
  let actual = await inspectWorker(store, docker);
  if (actual?.State.Running) {
    assert.ok(stop, 'Certificate worker is still running');
    if (!record.certificateWorker.stopIssued) {
      await store.change((r) => {
        r.certificateWorker.stopIssued = true;
      });
      await docker(['kill', '--signal=TERM', actual.Id]);
    }
    await wait('certificate worker physical shutdown', async () => {
      actual = await inspectWorker(store, docker);
      return actual && !actual.State.Running && actual.State.Status === 'exited';
    });
  }
  if (actual) {
    assert.equal(actual.State.Running, false);
    assert.ok(['created', 'exited'].includes(actual.State.Status), 'Certificate worker is not physically stopped');
    const worker = (await store.read()).record.certificateWorker;
    if (!worker.removeIssued) {
      await store.change((r) => {
        r.certificateWorker.removeIssued = true;
      });
      await docker(['rm', actual.Id]);
    }
    await wait('exact certificate worker absence', async () => !(await inspectWorker(store, docker)));
  }
  await store.change((r) => {
    r.certificateWorker.removed = true;
  });
}

export async function issueTemporaryCertificate(
  store,
  { hostname, publishChallenge, wait, guard },
  { docker = dockerCommand, fetchDirectory = fetch } = {},
) {
  let { record } = await store.read();
  const plan = record.plan;
  assert.equal(plan.hostnameMode, 'ip-encoded-http01');
  assert.equal(record.hostname.name, hostname);
  assert.ok(!record.certificateWorker, 'Never repeat an existing certificate request; inspect or clean up');
  temporaryAdmission(record);
  await guard(plan);
  const response = await fetchDirectory(directoryUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const directory = JSON.parse(await responseText(response, 65536));
  assert.equal(
    directory.meta?.termsOfService,
    plan.acme.termsUrl,
    'Certificate subscriber terms changed; obtain explicit approval',
  );
  const name = plan.operationId + '-certificate';
  assert.equal(
    (
      await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])
    ).trim(),
    '',
    'Reserved certificate worker exists',
  );
  const work = path.join(store.directory, 'certificate'),
    exchange = path.join(work, 'exchange'),
    state = path.join(work, 'state');
  await fs.mkdir(work, { mode: 0o700 });
  await fs.mkdir(exchange, { mode: 0o700 });
  await fs.mkdir(state, { mode: 0o700 });
  const policy = {
    hostname,
    deadline: Math.min(
      Date.now() + 10 * 60 * 1000,
      Date.parse(record.expiresAt) - plan.allowance.cleanupReserveSeconds * 1000,
    ),
  };
  assert.ok(policy.deadline > Date.now());
  await fs.writeFile(path.join(exchange, 'policy.json'), JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(exchange, 'auth.py'), temporaryAcmeHook, { flag: 'wx', mode: 0o600 });
  await guard(plan);
  temporaryAdmission((await store.read()).record);
  await store.change((r) => {
    r.certificateWorker = { name, absenceVerified: true, createIssued: true };
  });
  const id = (
    await docker([
      'create',
      '--pull=never',
      '--name',
      name,
      '--label',
      'rivet.temporary-certificate=' + plan.inputHash,
      '--user',
      `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
      '--cpus',
      '0.25',
      '--memory',
      '256m',
      '--pids-limit',
      '128',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--mount',
      `type=bind,source=${exchange},target=/exchange`,
      '--mount',
      `type=bind,source=${state},target=/state`,
      plan.acme.image,
      'certonly',
      '--manual',
      '--preferred-challenges=http',
      '--manual-auth-hook',
      'python3 /exchange/auth.py',
      '--agree-tos',
      '--register-unsafely-without-email',
      '--non-interactive',
      '--config-dir',
      '/state/config',
      '--work-dir',
      '/state/work',
      '--logs-dir',
      '/state/logs',
      '--cert-name',
      hostname,
      '-d',
      hostname,
      '--server',
      directoryUrl,
    ])
  ).trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  const created = await inspectWorker(store, docker);
  assert.equal(created.Id, id);
  assert.equal(created.State.Status, 'created');
  await guard(plan);
  temporaryAdmission((await store.read()).record);
  await store.change((r) => {
    r.certificateWorker.startIssued = true;
  });
  await docker(['start', id]);
  await wait('certificate request physical completion', async () => {
    await guard(plan);
    record = (await store.read()).record;
    temporaryAdmission(record);
    const actual = await inspectWorker(store, docker);
    assert.ok(actual);
    if (!record.certificateWorker.challengeVerified) {
      const bytes = await fs.readFile(path.join(exchange, 'challenge.json')).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (bytes) {
        assert.ok(bytes.length <= 2048);
        const packet = JSON.parse(bytes);
        assert.deepEqual(Object.keys(packet).sort(), ['token', 'validation']);
        assert.match(packet.token, /^[a-zA-Z0-9_-]{20,256}$/);
        assert.match(packet.validation, /^[a-zA-Z0-9_.-]{30,512}$/);
        await publishChallenge(packet);
        await store.change((r) => {
          r.certificateWorker.challengeVerified = true;
        });
        await fs.writeFile(path.join(exchange, 'verified'), temporaryHash(bytes), { flag: 'wx', mode: 0o600 });
      }
    }
    if (actual.State.Running) return false;
    assert.equal(actual.State.Status, 'exited');
    assert.equal(actual.State.ExitCode, 0, 'Certificate issuer failed; do not repeat its account/order');
    assert.ok((await store.read()).record.certificateWorker.challengeVerified);
    return true;
  });
  const pem = async (name) => {
    const file = await fs.realpath(path.join(state, 'config/live', hostname, name));
    assert.ok(file.startsWith((await fs.realpath(state)) + path.sep));
    const info = await fs.stat(file);
    assert.ok(info.isFile() && info.size < 65536);
    return fs.readFile(file);
  };
  const certificate = await pem('fullchain.pem'),
    key = await pem('privkey.pem');
  assertTemporaryCertificate(hostname, plan.allowance.maxSeconds, certificate, key);
  await settleTemporaryCertificate(store, { wait, docker });
  return { certificate, key };
}
