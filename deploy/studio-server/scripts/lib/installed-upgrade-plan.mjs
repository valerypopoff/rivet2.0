import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  createProductionHelmValues,
} from './studio-server-release-manifest.mjs';
import {
  assertHaUpgradeEvidence,
  assertRuntimeControlEvidence,
  assertRuntimeAutoscalingEvidence,
  assertCooperativeAutoscalingEvidence,
  assertOrdinaryRuntimeLayout,
} from './ha-release-evidence.mjs';

/** Publication is not installation. Walk only digest-verified promoted lineage,
 * then check each forward edge against the actual installation's topology. */
export async function planInstalledUpgrade({
  candidate,
  installed,
  fetchManifest,
  maximumHops = 16,
  autoscalingPolicyDigest,
  haRequested = false,
}) {
  candidate = assertStudioServerReleaseManifest(candidate, { requirePromoted: true });
  const installedDigest = installed?.release?.production?.manifestDigest;
  const targetDigest = getStudioServerReleaseManifestDigest(candidate, { requirePromoted: true });
  if (!installedDigest) throw Error('Installed release identity is required to plan an upgrade.');
  const installedSchema = installed.release.production.database?.managedWorkflowSchemaVersion;
  if (!Number.isSafeInteger(installedSchema) || installedSchema < 1)
    return {
      formatVersion: 1,
      status: 'maintenance-required',
      installedDigest,
      targetDigest,
      steps: [],
      reason:
        'The installed schema reader version is unknown or invalid; ordinary rolling compatibility cannot be established.',
    };
  if (installedDigest === targetDigest && installedSchema !== candidate.database.managedWorkflowSchema.version)
    return {
      formatVersion: 1,
      status: 'maintenance-required',
      installedDigest,
      targetDigest,
      steps: [],
      reason:
        'Installed schema metadata disagrees with its exact manifest; inspect the installation before proceeding.',
    };
  if (haRequested && !installed.ha?.enabled)
    return {
      formatVersion: 1,
      status: 'maintenance-required',
      installedDigest,
      targetDigest,
      steps: [],
      reason: 'First HA adoption requires explicit maintenance.',
    };
  const pending = [],
    seen = new Set();
  let release = candidate;
  while (getStudioServerReleaseManifestDigest(release, { requirePromoted: true }) !== installedDigest) {
    const digest = getStudioServerReleaseManifestDigest(release, { requirePromoted: true });
    if (seen.has(digest) || pending.length >= maximumHops)
      throw Error('Release lineage is cyclic or exceeds the bounded upgrade plan.');
    seen.add(digest);
    pending.unshift(release);
    const previous = release.lineage?.predecessor?.manifestDigest;
    if (previous === installedDigest) break;
    if (!previous)
      return {
        formatVersion: 1,
        status: 'qualification-required',
        installedDigest,
        targetDigest,
        steps: [],
        reason: 'The published lineage does not reach the installed release. Qualify the installed-to-candidate pair.',
      };
    release = assertStudioServerReleaseManifest(await fetchManifest(previous), { requirePromoted: true });
    if (getStudioServerReleaseManifestDigest(release, { requirePromoted: true }) !== previous)
      throw Error('Fetched predecessor does not match its recorded manifest digest.');
  }
  const steps = [];
  let current = installed;
  for (const next of pending) {
    try {
      if (current.ha?.enabled) {
        assertHaUpgradeEvidence(next, current);
        if (next.evidence.runtimeControl?.protocol === 3 && current.ha.controlPlane?.mode === 'singleton')
          return {
            formatVersion: 1,
            status: 'adoption-required',
            installedDigest,
            targetDigest,
            steps: [],
            reason:
              'Prepare the certified pool and same-image ownership transfer before the ordinary overlap image upgrade.',
            requiredPair: {
              installedSourceSha: current.release.production.sourceSha,
              candidateSourceSha: next.source.sha,
            },
          };
        assertOrdinaryRuntimeLayout(next.evidence.runtimeControl, current, autoscalingPolicyDigest);
        if (['singleton', 'singleton-overlap'].includes(current.ha.controlPlane?.mode))
          assertRuntimeControlEvidence(
            next.evidence.runtimeControl,
            next,
            current.availability?.gkeGatewayProfile ?? 'regional',
            current.ha.controlPlane?.mode === 'singleton-overlap',
          );
        if (autoscalingPolicyDigest) {
          const validate = next === candidate ? assertCooperativeAutoscalingEvidence : assertRuntimeAutoscalingEvidence;
          validate(next.evidence.runtimeAutoscaling, next, autoscalingPolicyDigest);
        }
      }
    } catch (error) {
      return {
        formatVersion: 1,
        status: 'qualification-required',
        installedDigest,
        targetDigest,
        steps: [],
        reason: error.message,
        requiredPair: { installedSourceSha: current.release.production.sourceSha, candidateSourceSha: next.source.sha },
      };
    }
    const schema = next.database.managedWorkflowSchema;
    if (
      current.release.production.database.managedWorkflowSchemaVersion < schema.minimumRollbackCompatibleVersion ||
      current.release.production.database.managedWorkflowSchemaVersion > schema.version
    )
      throw Error('The planned route contains an incompatible-reader hop requiring explicit maintenance.');
    steps.push({
      manifestDigest: getStudioServerReleaseManifestDigest(next, { requirePromoted: true }),
      sourceSha: next.source.sha,
      chart: next.chart,
      images: next.images,
      ...(autoscalingPolicyDigest
        ? {
            autoscalingDuringUpgrade: [2, 3].includes(next.evidence.runtimeAutoscaling?.protocol)
              ? 'scale-up-only'
              : 'legacy-frozen',
          }
        : {}),
    });
    const values = createProductionHelmValues(next);
    current = { ...current, images: values.images, release: values.release };
  }
  if (!steps.length && current.ha?.enabled) {
    try {
      assertHaUpgradeEvidence(candidate, installed);
      if (candidate.evidence.runtimeControl?.protocol === 3 && installed.ha.controlPlane?.mode === 'singleton')
        return {
          formatVersion: 1,
          status: 'adoption-required',
          installedDigest,
          targetDigest,
          steps: [],
          reason:
            'The candidate images are installed, but the separately approved same-image ownership transfer is still required.',
        };
      if (autoscalingPolicyDigest)
        assertCooperativeAutoscalingEvidence(candidate.evidence.runtimeAutoscaling, candidate, autoscalingPolicyDigest);
    } catch (error) {
      return {
        formatVersion: 1,
        status: 'qualification-required',
        installedDigest,
        targetDigest,
        steps: [],
        reason: error.message,
      };
    }
  }
  return {
    formatVersion: 1,
    status: steps.length ? 'qualified-route' : 'already-installed',
    installedDigest,
    targetDigest,
    steps,
  };
}
