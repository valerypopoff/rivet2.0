import assert from 'node:assert/strict';
import { assertRuntimeUpgradePair } from './runtime-upgrade-qualification.mjs';
import {
  assertHaUpgradeEvidence,
  assertRuntimeControlEvidence,
  assertOrdinaryRuntimeResources,
} from './ha-release-evidence.mjs';
import { getStudioServerReleaseManifestDigest } from './studio-server-release-manifest.mjs';

/** Delegate only a tested same-image preparation to the candidate certificate.
 * Application identity remains the installed predecessor; never rewrite its
 * immutable manifest or use this certificate for an image/schema change. */
export function overlapAdoptionAuthority(previous, certificate, stage) {
  assert.ok(['sizing', 'ownership'].includes(stage), 'Overlap adoption stage must be sizing or ownership');
  assertRuntimeUpgradePair(previous, certificate);
  const proof = assertRuntimeControlEvidence(certificate.evidence.runtimeControl, certificate, 'compact', true);
  assert.equal(proof.protocol, 3);
  assert.equal(proof.developerOverlap.sourceMode, 'singleton', 'Certificate did not test first adoption');
  assert.deepEqual(previous.chart, certificate.chart, 'Same-image adoption requires an unchanged chart');
  assert.equal(
    previous.database.managedWorkflowSchema.version,
    certificate.database.managedWorkflowSchema.version,
    'Same-image adoption cannot migrate the database',
  );
  return Object.freeze({
    stage,
    authorizationManifestDigest: getStudioServerReleaseManifestDigest(certificate, { requirePromoted: true }),
    installedManifestDigest: getStudioServerReleaseManifestDigest(previous, { requirePromoted: true }),
    sourcePool: proof.developerOverlap.sourcePool,
    profile: proof.developerOverlap.profile,
  });
}

export function assertOverlapAdoptionInstalled(authority, certificate, installed, { journal, resumeToken } = {}) {
  const recovering =
    journal &&
    journal.phase !== 'complete' &&
    journal.token === resumeToken &&
    resumeToken &&
    journal.manifestDigest === authority.installedManifestDigest &&
    journal.workflowIdentity?.authorizationManifestDigest === authority.authorizationManifestDigest &&
    journal.workflowIdentity.adoptionStage === authority.stage;
  assert.equal(installed.release?.production?.manifestDigest, authority.installedManifestDigest);
  const mode = installed.ha?.controlPlane?.mode;
  assert.ok(
    mode === 'singleton' ||
      (recovering &&
        authority.stage === 'ownership' &&
        ['templates', 'preflight'].includes(journal.phase) &&
        mode === 'singleton-overlap'),
    'Adoption must start from a settled singleton or its exact interrupted transition',
  );
  assertHaUpgradeEvidence(certificate, installed);
  assert.equal(installed.postgres?.maxConnections, authority.profile.maxConnections);
  assert.equal(installed.postgres?.reservedConnections, authority.profile.reservedConnections);
  const pool = installed.postgres?.poolMaxPerApiPod;
  assert.ok(
    pool === (authority.stage === 'sizing' ? authority.sourcePool : authority.profile.poolMaxPerApiPod) ||
      (recovering && authority.stage === 'sizing' && pool === authority.profile.poolMaxPerApiPod),
    'Finish the separate same-image pool preparation before transferring ownership',
  );
}

export function assertOverlapAdoptionResources(authority, resources, certificate) {
  assertOrdinaryRuntimeResources(certificate.evidence.runtimeControl, resources, {
    adoptionSizing: authority.stage === 'sizing',
  });
  for (const resource of resources.filter((r) => r.kind === 'StatefulSet')) {
    for (const c of resource.spec.template.spec.containers.filter((c) => ['backend', 'api'].includes(c.name))) {
      const pools = c.env.filter((e) => e.name === 'RIVET_DEPLOYMENT_DATABASE_POOL_MAX');
      assert.equal(pools.length, 1);
      assert.equal(pools[0].valueFrom, undefined);
      assert.equal(pools[0].value, String(authority.profile.poolMaxPerApiPod));
    }
  }
}

export function overlapAdoptionValues(values, profile, stage = 'sizing') {
  assert.ok(['sizing', 'ownership'].includes(stage));
  const target = structuredClone(values);
  target.postgres = {
    ...target.postgres,
    maxConnections: profile.maxConnections,
    reservedConnections: profile.reservedConnections,
    poolMaxPerApiPod: profile.poolMaxPerApiPod,
  };
  target.resources = { ...target.resources, backendOverlap: structuredClone(profile.backendResources) };
  target.ha = { ...target.ha, controlPlane: { mode: stage === 'sizing' ? 'singleton' : 'singleton-overlap' } };
  return target;
}
