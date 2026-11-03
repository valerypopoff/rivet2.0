import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDeploymentPolicy } from './deployment-workflow.mjs';
import { getStudioServerReleaseManifestDigest } from './studio-server-release-manifest.mjs';
import { continuityTimeoutMs } from './request-continuity.mjs';
import { prepareQualificationPolicy } from './runtime-qualification-readiness.mjs';
import { privateCloudEvidence } from './private-cloud-evidence.mjs';

/** One deployment invocation owns live checks, checkpoint, rollout and acceptance.
 * Inputs come from the successful qualification and protected runner settings;
 * dispatch cannot supply shell commands, values or a different image. */
export async function deployQualifiedRelease({
  root,
  packet,
  operation,
  manifest,
  digest,
  sourceSha,
  valuesFile,
  policyFile,
  privateStore,
  evidenceBucket,
  identity,
  run,
}) {
  assert.equal(getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true }), digest);
  assert.equal(manifest.source.sha, sourceSha);
  assert.equal(manifest.source.sha, operation.candidate.sourceSha);
  assert.deepEqual(manifest.images, operation.candidate.images);
  assert.equal(manifest.chart.contentDigest, operation.candidate.chartDigest);
  assert.equal(manifest.lineage.predecessor.manifestDigest, operation.predecessorManifestDigest);
  assert.equal(operation.installed.manifestDigest, operation.predecessorManifestDigest);
  assert.equal(
    manifest.evidence.runtimeControl?.controlPlaneMode,
    'singleton',
    'Backend overlap adoption uses its explicit maintenance/ownership procedure',
  );
  const bytes = await fs.readFile(valuesFile);
  assert.equal(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    operation.installed.valuesDigest,
    'Production settings changed since staging qualification',
  );
  const artifacts = path.join(packet, 'private-deployment');
  const relative = path.relative(await fs.realpath(root), await fs.realpath(packet));
  assert.ok(
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'Deployment packet must remain in the checkout',
  );
  await fs.mkdir(artifacts, { mode: 0o700 }); // Never replay an uncertain attempt.
  policyFile = await prepareQualificationPolicy({ policyFile, root, packet: artifacts, identity });
  const approval = await readDeploymentPolicy(policyFile, root, identity);
  assert.equal(approval.policy.namespaceUid, operation.installed.namespaceUid);
  const file = path.join(artifacts, 'manifest.json');
  const values = path.join(artifacts, 'values.yaml');
  await fs.writeFile(file, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(values, bytes, { flag: 'wx', mode: 0o600 });
  assert.ok(privateStore && path.isAbsolute(privateStore), 'A durable private deployment store is required');
  await fs.mkdir(privateStore, { recursive: true, mode: 0o700 });
  const storeRelative = path.relative(await fs.realpath(root), await fs.realpath(privateStore));
  assert.ok(
    storeRelative === '..' || storeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(storeRelative),
    'Deployment receipts must survive checkout cleaning outside the repository',
  );
  assert.match(operation.operationId, /^rivet-q-[1-9][0-9]*-[1-9][0-9]*$/);
  const archive = path.join(privateStore, operation.operationId);
  await fs.mkdir(archive, { mode: 0o700 }); // Persistent replay fence, even after checkout cleaning.
  const cloud = evidenceBucket
    ? privateCloudEvidence({ bucket: evidenceBucket, prefix: `production/${operation.operationId}` })
    : undefined;
  await cloud?.acquire(Buffer.from(JSON.stringify({ operationId: operation.operationId, digest })));
  await cloud?.saveDirectory(artifacts);
  const profile = manifest.evidence.runtimeControl.requestContinuity?.profile;
  try {
    await run(
      process.execPath,
      [
        path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'),
        '--manifest',
        file,
        '--values',
        values,
        '--deployment-policy',
        policyFile,
        '--expected-installed-settings-digest',
        operation.installed.settingsDigest,
        '--context',
        identity.context,
        '--namespace',
        identity.namespace,
        '--release',
        identity.release,
        '--confirm',
        identity.release,
        '--artifacts',
        artifacts,
        ...(profile ? ['--timeout', `${continuityTimeoutMs(profile) / 1000}s`] : []),
      ],
      {
        capture: true,
        env: {
          ...process.env,
          ...(evidenceBucket
            ? {
                RIVET_PRODUCTION_EVIDENCE_BUCKET: evidenceBucket,
                RIVET_PRODUCTION_EVIDENCE_PREFIX: `production/${operation.operationId}`,
              }
            : {}),
        },
      },
    );
  } catch (error) {
    await fs.writeFile(
      path.join(artifacts, 'command-failure.log'),
      String(error?.message ?? 'Deployment command failed').slice(0, 1048576),
      { flag: 'wx', mode: 0o600 },
    );
    throw error;
  } finally {
    await fs.cp(artifacts, path.join(archive, 'receipts'), { recursive: true, errorOnExist: true, force: false });
    await cloud?.saveDirectory(artifacts);
  }
  const result = JSON.parse(await fs.readFile(path.join(artifacts, 'deployment-result.json'), 'utf8'));
  assert.equal(result.state, 'complete');
  assert.equal(result.candidateManifestDigest, digest);
  assert.deepEqual(result.outcome, { infrastructure: 'applied', autoscaling: 'verified', application: 'passed' });
  return { status: 'deployed', manifestDigest: digest, sourceSha, observedAt: new Date().toISOString() };
}
