import assert from 'node:assert/strict';
import { createHash, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';

export const temporaryHash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex');

export function temporaryCleanupReceipt(record, verifiedAt) {
  assert.ok(typeof verifiedAt === 'string' && Number.isFinite(Date.parse(verifiedAt)));
  assert.equal(new Date(verifiedAt).toISOString(), verifiedAt);
  return immutable({
    protocol: 1,
    operationId: record.plan.operationId,
    inputHash: record.plan.inputHash,
    cleanupVerified: true,
    verifiedAt,
    inventoryHash: temporaryHash({
      resources: record.resources,
      bootstrapChildren: record.bootstrapChildren ?? [],
      edgeChildren: record.edgeChildren ?? [],
      dns: record.dns ?? null,
      iam: record.iam ?? [],
      ...(record.certificateWorker ? { certificateWorker: record.certificateWorker } : {}),
    }),
  });
}

/** Historical acknowledgement only: this neither re-inspects the provider nor
 * gives permission to replay a write or certify a different operation. */
export function completedTemporaryCleanup(record) {
  assert.ok(record.closed && record.complete && record.cleanupVerified, 'Verified cleanup is required');
  assert.ok(['cleaned', 'cleaned-unactivated'].includes(record.phase), 'Cleanup is not terminal');
  assert.ok(record.cleanupReceipt, 'Missing bound cleanup receipt; inspect without inventing an acknowledgement');
  assert.ok(!record.certificateWorker || record.certificateWorker.removed, 'Certificate worker cleanup is unverified');
  assert.deepEqual(
    record.cleanupReceipt,
    temporaryCleanupReceipt(record, record.finishedAt),
    'Cleanup receipt authority changed',
  );
  return structuredClone(record.cleanupReceipt);
}
export function immutable(value) {
  const copy = structuredClone(value);
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(copy);
}
const exact = (value, keys) =>
  assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'Missing or unreviewed temporary-staging fields');
const cidr = (value, max = 30) => {
  const [address, mask, extra] = value.split('/');
  assert.equal(isIP(address), 4);
  assert.equal(extra, undefined);
  assert.match(mask, /^\d+$/);
  assert.ok(+mask >= 8 && +mask <= max);
  const n = address.split('.').reduce((v, x) => (v * 256 + +x) >>> 0, 0);
  const size = 2 ** (32 - +mask);
  assert.equal(n % size, 0, 'CIDR is not a network address');
  return [n, n + size - 1];
};
export function temporaryStagingPlan(input) {
  exact(input, [
    'protocol',
    'operationId',
    'projectId',
    'projectNumber',
    'region',
    'sourceSha',
    'candidateDigest',
    'predecessorDigest',
    'actorImage',
    'nodeServiceAccount',
    'janitorServiceAccount',
    'domain',
    'managedZone',
    'cidrs',
    'trustedClients',
    'allowance',
    'codeHashes',
    'certificateSha256',
    'privateKeySha256',
    'actorSourceRoot',
    'postgresImage',
    'objectStorageImage',
    'operatorServiceAccount',
    'kubernetesVersion',
    'estimate',
    ...(input.registrySecretSha256 ? ['registrySecretSha256'] : []),
    ...(input.hostnameMode === undefined ? [] : ['hostnameMode', 'acme']),
  ]);
  assert.equal(input.protocol, 1);
  assert.match(input.operationId, /^rivet-q-[1-9][0-9]*-[1-9][0-9]*$/);
  assert.ok(input.operationId.length <= 40);
  assert.match(input.projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
  assert.notEqual(input.projectId, 'wartime-storyteller');
  assert.match(input.projectNumber, /^[1-9][0-9]{5,20}$/);
  assert.match(input.region, /^[a-z]+-[a-z]+[1-9][0-9]*$/);
  assert.match(input.sourceSha, /^[a-f0-9]{40}$/);
  for (const key of ['candidateDigest', 'predecessorDigest']) assert.match(input[key], /^sha256:[a-f0-9]{64}$/);
  for (const key of ['actorImage', 'postgresImage', 'objectStorageImage'])
    assert.match(input[key], /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  for (const key of ['nodeServiceAccount', 'janitorServiceAccount', 'operatorServiceAccount']) {
    assert.match(input[key], /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/);
    assert.equal(input[key].split('@')[1], `${input.projectId}.iam.gserviceaccount.com`);
  }
  assert.equal(
    new Set([input.nodeServiceAccount, input.janitorServiceAccount, input.operatorServiceAccount]).size,
    3,
    'Node, in-cluster reader and external operator must use distinct staging identities',
  );
  assert.match(input.kubernetesVersion, /^\d+\.\d+\.\d+-gke\.\d+$/);
  exact(input.estimate, ['usd', 'cpus', 'ssdGb', 'externalAddresses', 'evidenceSha256']);
  assert.ok(Number.isSafeInteger(input.estimate.externalAddresses) && input.estimate.externalAddresses >= 2);
  for (const key of ['usd', 'cpus', 'ssdGb'])
    assert.ok(Number.isFinite(input.estimate[key]) && input.estimate[key] > 0);
  assert.match(input.estimate.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.match(input.domain, /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/);
  assert.ok(!input.domain.includes('litnet.com'));
  if (input.hostnameMode !== undefined) {
    assert.equal(input.hostnameMode, 'ip-encoded-http01');
    assert.equal(input.domain, 'sslip.io');
    assert.equal(input.managedZone, null);
    assert.equal(input.certificateSha256, null);
    assert.equal(input.privateKeySha256, null);
    exact(input.acme, ['image', 'termsUrl', 'subscriberTermsApproved', 'certificateIssuanceApproved']);
    assert.match(input.acme.image, /^(?:docker\.io\/)?certbot\/certbot@sha256:[a-f0-9]{64}$/);
    assert.equal(input.acme.subscriberTermsApproved, true);
    assert.equal(input.acme.certificateIssuanceApproved, true);
    assert.match(input.acme.termsUrl, /^https:\/\/letsencrypt\.org\/documents\/[a-zA-Z0-9._-]+\.pdf$/);
  } else assert.match(input.managedZone, /^[a-z][a-z0-9-]+$/);
  assert.match(input.actorSourceRoot, /^\/[a-zA-Z0-9_/-]+$/);
  assert.ok(!input.actorSourceRoot.includes('..'));
  assert.equal(input.actorSourceRoot, '/app', 'The maintained actor/janitor image uses /app');
  exact(input.cidrs, ['nodes', 'pods', 'services', 'proxy']);
  const ranges = Object.values(input.cidrs).map((value) => cidr(value));
  for (const [low, high] of ranges)
    assert.ok(
      [
        [0x0a000000, 0x0affffff],
        [0xac100000, 0xac1fffff],
        [0xc0a80000, 0xc0a8ffff],
      ].some(([a, b]) => low >= a && high <= b),
      'Staging ranges must be private',
    );
  for (let i = 0; i < ranges.length; i++)
    for (let j = 0; j < i; j++)
      assert.ok(ranges[i][1] < ranges[j][0] || ranges[j][1] < ranges[i][0], 'Overlapping staging ranges');
  assert.ok(+input.cidrs.proxy.split('/')[1] <= 26);
  assert.ok(Array.isArray(input.trustedClients) && input.trustedClients.length);
  input.trustedClients.forEach((value) => cidr(value, 32));
  exact(input.allowance, ['maxUsd', 'maxSeconds', 'cleanupReserveSeconds', 'minimumTestSeconds', 'approvalExpiresAt']);
  assert.ok(Number.isFinite(input.allowance.maxUsd) && input.allowance.maxUsd > 0);
  assert.ok(input.estimate.usd <= input.allowance.maxUsd, 'Reviewed estimate exceeds allowance');
  for (const key of ['maxSeconds', 'cleanupReserveSeconds', 'minimumTestSeconds'])
    assert.ok(Number.isSafeInteger(input.allowance[key]) && input.allowance[key] > 0);
  assert.ok(
    input.allowance.maxSeconds <= 86400 &&
      input.allowance.maxSeconds > input.allowance.cleanupReserveSeconds + input.allowance.minimumTestSeconds,
  );
  assert.ok(Number.isFinite(Date.parse(input.allowance.approvalExpiresAt)));
  assert.match(input.allowance.approvalExpiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/);
  if (!input.hostnameMode)
    for (const key of ['certificateSha256', 'privateKeySha256']) assert.match(input[key], /^[a-f0-9]{64}$/);
  if (input.registrySecretSha256) assert.match(input.registrySecretSha256, /^[a-f0-9]{64}$/);
  assert.ok(input.codeHashes && Object.keys(input.codeHashes).length);
  for (const [file, hash] of Object.entries(input.codeHashes)) {
    assert.match(file, /^(?:deploy\/studio-server\/|\.github\/workflows\/)[a-zA-Z0-9_.\/-]+$/);
    assert.ok(!file.split('/').includes('..'));
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
  return immutable({ ...input, inputHash: temporaryHash(input) });
}
export function verifyTemporaryPlan(plan) {
  const { inputHash, ...input } = plan;
  const expected = temporaryStagingPlan(input);
  assert.equal(expected.inputHash, inputHash);
  return expected;
}
export function verifyTemporaryCertificate(plan, certificate, key, now = Date.now()) {
  assert.equal(temporaryHash(certificate), plan.certificateSha256);
  assert.equal(temporaryHash(key), plan.privateKeySha256);
  assertTemporaryCertificate(`${plan.operationId}.${plan.domain}`, plan.allowance.maxSeconds, certificate, key, now);
}
export function temporaryHostname(plan, address) {
  if (!plan.hostnameMode) return `${plan.operationId}.${plan.domain}`;
  assert.equal(plan.hostnameMode, 'ip-encoded-http01');
  assert.equal(isIP(address), 4);
  assert.ok(!/^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address));
  assert.ok(Number(address.split('.')[0]) < 224);
  return `${plan.operationId}.${address.replaceAll('.', '-')}.sslip.io`;
}
export function assertTemporaryCertificate(hostname, maxSeconds, certificate, key, now = Date.now()) {
  const cert = new X509Certificate(certificate);
  assert.ok(cert.checkHost(hostname));
  assert.ok(Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now + maxSeconds * 1000);
  assert.equal(
    createPublicKey(createPrivateKey(key))
      .export({ type: 'spki', format: 'der' })
      .equals(cert.publicKey.export({ type: 'spki', format: 'der' })),
    true,
  );
}
export function temporaryAdmission(record, { now = Date.now(), tests = false } = {}) {
  assert.ok(!record.closed && !record.complete, 'Temporary environment admission is closed');
  assert.ok(now < Date.parse(record.plan.allowance.approvalExpiresAt), 'Spending approval expired');
  if (record.expiresAt)
    assert.ok(
      now < Date.parse(record.expiresAt) - (tests ? record.plan.allowance.cleanupReserveSeconds * 1000 : 0),
      'Temporary environment deadline reached',
    );
  if (tests)
    assert.ok(
      record.expiresAt &&
        Date.parse(record.expiresAt) - now >=
          (record.plan.allowance.cleanupReserveSeconds + record.plan.allowance.minimumTestSeconds) * 1000,
      'Insufficient protected-test and cleanup time remains',
    );
}
export function temporaryExpiry(record) {
  // An interrupted free-network preparation must not hold quota forever merely
  // because the first paid request was never issued.
  return Date.parse(record.expiresAt ?? record.plan.allowance.approvalExpiresAt);
}
export function temporaryBinding(record, identities) {
  assert.ok(record.firstBillableIntentAt && record.expiresAt);
  return immutable({
    ...identities,
    protocol: 1,
    operationId: record.plan.operationId,
    inputHash: record.plan.inputHash,
    projectId: record.plan.projectId,
    projectNumber: record.plan.projectNumber,
    firstBillableIntentAt: record.firstBillableIntentAt,
    expiresAt: record.expiresAt,
    maxUsd: record.plan.allowance.maxUsd,
  });
}
