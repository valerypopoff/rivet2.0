export const HA_REQUIRED_CHECKS = [
  'two-ready-backends',
  'continuous-public-traffic',
  'editor-resume',
  'latest-debugger-mesh',
  'long-and-paused-runs',
  'early-output-recording',
  'evaluation-retirement',
  'maintenance-owner',
  'shared-bundle-download',
  'fenced-uid-replacement',
  'browser-version-continuity',
  'retained-browser-workflow',
  'oldest-browser-compatibility',
];
// Reset when old browser code cannot meet the required lifetime guarantee,
// even if wire messages remain compatible. Establish through maintenance.
// Contract 2 keeps recording capture alive across resumable socket replacement.
export const HA_BROWSER_CONTRACT = 2;
export const HA_RUNTIME_CONTROL_CHECKS = [
  'cold-runtime-without-developers',
  'published-browser-oauth-actions',
  'published-schedule-claims',
  'recording-durability',
  'embedded-maintenance-recovery',
  'embedded-maintenance-capacity',
  'exclusive-restore-volume-transfer',
  'reverse-control-transfer',
  'serial-developer-replacement',
  'two-ready-execution-owners',
  'mixed-version-runtime-upgrade',
];

/** Separate evidence is necessary: a two-editor/full-HA certificate is not
 * qualification of a singleton developer/embedded-maintenance layout. */
export const HA_COMPACT_EDGE_CHECKS = [
  'compact-proxy-rolling-upgrade',
  'compact-proxy-eviction',
  'edge-profile-transition',
];
export const HA_AUTOSCALING_CHECKS = [
  'slot-and-cpu-scale-up',
  'stabilized-scale-down',
  'long-run-and-recording-drain',
  'traffic-return-during-drain',
  'controller-restart-and-lost-ack',
  'deployment-serialization',
  'stale-metrics-fence',
  'voluntary-eviction-fence',
  'provider-node-capacity',
];
export const HA_COOPERATIVE_AUTOSCALING_CHECKS = [
  ...HA_AUTOSCALING_CHECKS,
  'upgrade-scale-up-only',
  'paused-upgrade-scale-up',
];
export function assertRuntimeAutoscalingEvidence(value, release, policyDigest) {
  const required = value?.protocol === 2 ? HA_COOPERATIVE_AUTOSCALING_CHECKS : HA_AUTOSCALING_CHECKS;
  if (
    ![1, 2].includes(value?.protocol) ||
    value.candidateSourceSha !== release.source.sha ||
    !equal(value.candidateImages, release.images) ||
    value.chartDigest !== release.chart.contentDigest ||
    !/^[a-f0-9]{64}$/.test(value.policyDigest ?? '') ||
    (policyDigest && value.policyDigest !== policyDigest) ||
    value.failedRequests !== 0 ||
    !Number.isSafeInteger(value.requestSamples) ||
    value.requestSamples < 100 ||
    value.provider !== 'gke' ||
    !Array.isArray(value.checks) ||
    value.checks.length !== required.length ||
    new Set(value.checks).size !== required.length ||
    !required.every((c) => value.checks.includes(c))
  )
    throw new Error(
      'Automatic execution retirement requires exact image/chart/policy GKE qualification; previous HA evidence does not suffice.',
    );
  return {
    protocol: value.protocol,
    candidateSourceSha: value.candidateSourceSha,
    candidateImages: release.images,
    chartDigest: value.chartDigest,
    policyDigest: value.policyDigest,
    provider: 'gke',
    failedRequests: 0,
    requestSamples: value.requestSamples,
    checks: [...required],
  };
}

export function assertCooperativeAutoscalingEvidence(value, release, policyDigest) {
  const proof = assertRuntimeAutoscalingEvidence(value, release, policyDigest);
  if (proof.protocol !== 2)
    throw Error('Scale-up during upgrades requires v2 autoscaling qualification including paused-upgrade recovery.');
  return proof;
}
export const HA_DEVELOPER_OVERLAP_CHECKS = [
  'same-node-backend-overlap',
  'exclusive-housekeeping-handover',
  'accepted-editor-run-continuity',
  'bundle-debugger-continuity',
  'interrupted-handover-recovery',
  'return-to-single-backend',
];
export function assertRuntimeControlEvidence(value, release, expectedEdgeProfile, requireDeveloperOverlap = false) {
  const overlap = value?.developerOverlap;
  if (
    (requireDeveloperOverlap || overlap) &&
    (overlap?.protocol !== 1 ||
      !Array.isArray(overlap.checks) ||
      overlap.checks.length !== HA_DEVELOPER_OVERLAP_CHECKS.length ||
      new Set(overlap.checks).size !== HA_DEVELOPER_OVERLAP_CHECKS.length ||
      !HA_DEVELOPER_OVERLAP_CHECKS.every((check) => overlap.checks.includes(check)))
  )
    throw Error('Developer overlap requires its own exact-image handover and session-continuity qualification.');
  const profiles = value?.edgeProfiles ?? ['regional'];
  if (
    !Array.isArray(profiles) ||
    !profiles.length ||
    new Set(profiles).size !== profiles.length ||
    profiles.some((p) => !['regional', 'compact'].includes(p)) ||
    (expectedEdgeProfile !== undefined && !profiles.includes(expectedEdgeProfile))
  )
    throw new Error('Runtime HA evidence does not qualify the requested GKE edge profile.');
  const required = [...HA_RUNTIME_CONTROL_CHECKS, ...(profiles.includes('compact') ? HA_COMPACT_EDGE_CHECKS : [])];
  if (
    value?.protocol !== 1 ||
    value.candidateSourceSha !== release.source.sha ||
    !equal(value.candidateImages, release.images) ||
    value.chartDigest !== release.chart.contentDigest ||
    value.failedRequests !== 0 ||
    !Number.isSafeInteger(value.requestSamples) ||
    value.requestSamples < 100 ||
    !Array.isArray(value.checks) ||
    value.checks.length !== required.length ||
    new Set(value.checks).size !== required.length ||
    !required.every((c) => value.checks.includes(c)) ||
    !release.lineage?.predecessor ||
    value.predecessorSourceSha !== release.lineage?.predecessor?.sourceSha ||
    !equal(value.predecessorImages, release.lineage?.predecessor?.images) ||
    equal(value.predecessorImages, release.images)
  )
    throw new Error(
      'Singleton runtime HA requires its own exact mixed-image qualification; full-HA evidence does not suffice.',
    );
  return {
    protocol: 1,
    candidateSourceSha: value.candidateSourceSha,
    candidateImages: release.images,
    chartDigest: value.chartDigest,
    failedRequests: 0,
    requestSamples: value.requestSamples,
    predecessorSourceSha: value.predecessorSourceSha,
    predecessorImages: value.predecessorImages,
    ...(value.edgeProfiles ? { edgeProfiles: [...profiles] } : {}),
    ...(overlap ? { developerOverlap: { protocol: 1, checks: [...HA_DEVELOPER_OVERLAP_CHECKS] } } : {}),
    checks: required,
  };
}
const legacyChecks = (version) =>
  HA_REQUIRED_CHECKS.filter(
    (check) =>
      ![
        'retained-browser-workflow',
        'oldest-browser-compatibility',
        ...(version === 1 ? ['browser-version-continuity'] : []),
      ].includes(check),
  );
function assertBrowserContract(value) {
  if (
    !Number.isSafeInteger(value?.protocol) ||
    value.protocol < 1 ||
    !/^[a-f0-9]{40}$/.test(value.baseline?.sourceSha ?? '') ||
    typeof value.baseline?.image?.repository !== 'string' ||
    !value.baseline.image.repository ||
    !/^sha256:[a-f0-9]{64}$/.test(value.baseline.image.digest ?? '')
  )
    throw Error('HA browser compatibility baseline is missing or invalid.');
  return value;
}
export function selectHaBrowserContract(candidate, previous) {
  const prior = previous?.evidence?.ha;
  if (prior?.protocol === 3 && prior.browserContract?.protocol === HA_BROWSER_CONTRACT)
    return structuredClone(assertBrowserContract(prior.browserContract));
  return { protocol: HA_BROWSER_CONTRACT, baseline: { sourceSha: candidate.source.sha, image: candidate.images.web } };
}
const browserWorkflowPassed = (value) =>
  value?.passed === true &&
  value.reloads === 0 &&
  value.iframeReloads === 0 &&
  [
    'lazyScreen',
    'pinnedEditor',
    'oldWebPodsRemoved',
    'unsavedEdit',
    'savedByCandidate',
    'newRun',
    'outputs',
    'recordingOpened',
  ].every((k) => value[k] === true) &&
  /^[a-f0-9]{64}$/.test(value.originalBuild ?? '') &&
  /^[a-f0-9]{64}$/.test(value.candidateBuild ?? '') &&
  Array.isArray(value.recordingIds) &&
  value.recordingIds.length === 2 &&
  value.recordingIds.every((id) => typeof id === 'string' && id.length > 0) &&
  new Set(value.recordingIds).size === 2;
const stable = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)]),
      )
    : value;
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const hasNotificationProof = (receipt) =>
  receipt?.directions?.length === 2 &&
  ['local-to-peer', 'peer-to-local'].every((direction) =>
    receipt.directions.some(
      (d) =>
        d.direction === direction &&
        d.tree === true &&
        d.library === true &&
        Number.isSafeInteger(d.revision) &&
        d.revision > 0,
    ),
  );

/** Build a certificate only from completed workload receipts and actual pod
 * replacement observations. Calling this with a checklist is not sufficient. */
export function createHaReleaseEvidence(report, release, mode) {
  const fail = () => {
    throw Error('HA behavioral report is incomplete; no certificate was created.');
  };
  const work = report?.workloads;
  if (
    !browserWorkflowPassed(work?.browser) ||
    !browserWorkflowPassed(work?.oldestBrowser) ||
    !equal(work.oldestBrowser.image, report.browserContract?.baseline?.image)
  )
    fail();
  const browserContract = assertBrowserContract(report.browserContract);
  if (
    !hasNotificationProof(work?.folderNotifications) ||
    work?.notifications?.length !== 2 ||
    work.notifications.some((p) => !hasNotificationProof(p.receipt))
  )
    fail();
  if (
    !report ||
    report.failures?.length !== 0 ||
    !Number.isSafeInteger(report.samples) ||
    report.samples < 100 ||
    !Array.isArray(report.readiness) ||
    report.readiness.length < 2 ||
    report.readiness.some((s) => !Number.isSafeInteger(s.ready) || s.ready < 2) ||
    report.rollout?.phase !== 'complete' ||
    !work ||
    work.bundleVerified !== true ||
    work.editors?.length !== 2 ||
    work.editors.some(
      (p) =>
        p.receipt?.phase !== 'passed' ||
        p.receipt.editorResumed !== true ||
        p.receipt.latestMesh !== true ||
        !Number.isSafeInteger(p.receipt.heldMs) ||
        p.receipt.heldMs < 25_000 ||
        p.receipt.starts !== 1 ||
        p.receipt.completions !== 1 ||
        p.receipt.latestPauseCount !== 1,
    ) ||
    work.evaluations?.length !== 2 ||
    work.evaluations.some((p) => p.preserved !== true || !p.jobs?.length || p.jobs.some((j) => j.attempt !== 1)) ||
    work.background?.length !== 2 ||
    work.background.some((p) => !p.recordingId || !p.correlationId)
  )
    fail();
  if (
    report.recovery?.failures?.length !== 0 ||
    !Number.isSafeInteger(report.recovery.samples) ||
    report.recovery.samples < 100 ||
    !['lostAcknowledgement', 'leaseLoss'].every(
      (kind) => report.recovery[kind]?.passed === true && report.recovery[kind].beginCommands === 1,
    ) ||
    report.recovery.leaseLoss.conflictObserved !== true
  )
    fail();
  const original = report.before?.filter((p) =>
    ['backend', 'execution', 'maintenance'].includes(p.metadata?.labels?.['app.kubernetes.io/component']),
  );
  if (
    original?.length !== 5 ||
    new Set(original.map((p) => p.metadata.uid)).size !== 5 ||
    ['backend', 'execution', 'maintenance'].some(
      (role) =>
        original.filter((p) => p.metadata.labels['app.kubernetes.io/component'] === role).length !==
        (role === 'maintenance' ? 1 : 2),
    )
  )
    fail();
  const baselineImages = mode === 'mixed' ? release.lineage?.predecessor?.images : release.images;
  const baseline = baselineImages?.api;
  const originalWeb = report.before?.filter((p) => p.metadata?.labels?.['app.kubernetes.io/component'] === 'web');
  const currentWeb = report.after?.filter((p) => p.metadata?.labels?.['app.kubernetes.io/component'] === 'web');
  if (
    !originalWeb?.length ||
    !currentWeb?.length ||
    !baselineImages?.web ||
    originalWeb.some(
      (p) =>
        !p.spec?.containers.some(
          (c) => c.name === 'web' && c.image === `${baselineImages.web.repository}@${baselineImages.web.digest}`,
        ),
    ) ||
    currentWeb.some(
      (p) =>
        originalWeb.some((old) => old.metadata.uid === p.metadata.uid) ||
        !p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ||
        !p.spec?.containers.some(
          (c) => c.name === 'web' && c.image === `${release.images.web.repository}@${release.images.web.digest}`,
        ),
    )
  )
    fail();
  for (const pod of original) {
    const replacement = report.after?.find((p) => p.metadata.name === pod.metadata.name);
    if (
      !baseline ||
      !pod.spec?.containers.some(
        (c) => ['backend', 'api'].includes(c.name) && c.image === `${baseline.repository}@${baseline.digest}`,
      ) ||
      !replacement ||
      replacement.metadata.uid === pod.metadata.uid ||
      !replacement.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ||
      !replacement.spec.containers.some(
        (c) =>
          ['backend', 'api'].includes(c.name) &&
          c.image === `${release.images.api.repository}@${release.images.api.digest}`,
      ) ||
      !work.withdrawn?.some((p) => p.pod === pod.metadata.name && p.uid === pod.metadata.uid)
    )
      fail();
  }
  for (const [probes, role] of [
    [work.editors, 'backend'],
    [work.notifications, 'backend'],
    [work.evaluations, 'backend'],
    [work.background, 'execution'],
  ]) {
    if (
      new Set(probes.map((p) => p.uid)).size !== 2 ||
      probes.some(
        (p) =>
          !original.some(
            (o) =>
              o.metadata.name === p.pod &&
              o.metadata.uid === p.uid &&
              o.metadata.labels['app.kubernetes.io/component'] === role,
          ),
      )
    )
      fail();
  }
  return assertHaReleaseEvidence(
    {
      protocol: 3,
      browserContract,
      mode,
      candidateSourceSha: release.source.sha,
      candidateImages: release.images,
      chartDigest: release.chart.contentDigest,
      requestSamples: report.samples,
      failedRequests: 0,
      checks: [...HA_REQUIRED_CHECKS],
      ...(mode === 'mixed'
        ? {
            predecessorSourceSha: release.lineage?.predecessor?.sourceSha,
            predecessorImages: release.lineage?.predecessor?.images,
          }
        : {}),
    },
    release,
  );
}

/** This evidence is part of the promoted manifest identity, not an operator
 * claim in values.yaml. The CI gate must bind the exact image/source pair. */
export function assertHaReleaseEvidence(value, release) {
  // Historical manifests remain readable for lineage and maintenance upgrades;
  // Legacy receipts remain readable, but cannot authorize the stronger contract.
  const required = value?.protocol === 3 ? HA_REQUIRED_CHECKS : legacyChecks(value?.protocol);
  if (
    !value ||
    ![1, 2, 3].includes(value.protocol) ||
    !['bootstrap', 'mixed'].includes(value.mode) ||
    value.candidateSourceSha !== release.source.sha ||
    !equal(value.candidateImages, release.images) ||
    value.chartDigest !== release.chart.contentDigest ||
    value.failedRequests !== 0 ||
    !Number.isSafeInteger(value.requestSamples) ||
    value.requestSamples < 100 ||
    !Array.isArray(value.checks) ||
    new Set(value.checks).size !== required.length ||
    value.checks.length !== required.length ||
    !required.every((check) => value.checks?.includes(check))
  )
    throw new Error('HA compatibility evidence is incomplete or belongs to another candidate.');
  const previous = release.lineage?.predecessor;
  const browserContract = value.protocol === 3 ? assertBrowserContract(value.browserContract) : undefined;
  if (
    value.mode === 'mixed' &&
    (!previous ||
      value.predecessorSourceSha !== previous.sourceSha ||
      !equal(value.predecessorImages, previous.images) ||
      equal(previous.images, release.images))
  )
    throw new Error('HA mixed-version evidence does not match the exact predecessor.');
  return {
    protocol: value.protocol,
    ...(browserContract ? { browserContract: structuredClone(browserContract) } : {}),
    mode: value.mode,
    candidateSourceSha: value.candidateSourceSha,
    candidateImages: release.images,
    chartDigest: value.chartDigest,
    failedRequests: 0,
    requestSamples: value.requestSamples,
    checks: [...required],
    ...(value.mode === 'mixed' ? { predecessorSourceSha: previous.sourceSha, predecessorImages: previous.images } : {}),
  };
}

export function assertHaUpgradeEvidence(manifest, installed) {
  const evidence = assertHaReleaseEvidence(manifest.evidence?.ha, manifest);
  if (evidence.protocol !== 3)
    throw new Error(
      'Browser-continuous HA requires a v3 release certificate. Use a maintenance cutover for legacy HA.',
    );
  if (!installed) return;
  // A larger destination does not qualify the smaller source while its owners
  // are still serving during the roll. Check this before the same-image shortcut.
  if (installed.availability?.gkeGatewayProfile === 'compact')
    assertRuntimeControlEvidence(manifest.evidence?.runtimeControl, manifest, 'compact');
  if (!installed.ha?.enabled) throw new Error('First HA conversion requires an explicit maintenance cutover.');
  if (!equal(evidence.browserContract, installed.release?.production?.browserContract))
    throw Error('Changing the supported browser contract or baseline requires maintenance, not rolling HA.');
  const sameSource = installed.release?.production?.sourceSha === manifest.source.sha;
  const installedMatches = (images) =>
    Object.entries(images).every(
      ([name, image]) =>
        image.repository === installed.images?.[name]?.repository && image.digest === installed.images?.[name]?.digest,
    );
  if (sameSource && installedMatches(manifest.images)) return;
  if (evidence.mode !== 'mixed' || evidence.predecessorSourceSha !== installed.release?.production?.sourceSha)
    throw new Error(
      sameSource
        ? 'Same-source HA images differ; no exact predecessor image certificate is available.'
        : 'No mixed-version certificate for the installed HA source.',
    );
  for (const [component, image] of Object.entries(evidence.predecessorImages)) {
    if (
      image.repository !== installed.images?.[component]?.repository ||
      image.digest !== installed.images?.[component]?.digest
    )
      throw new Error(
        sameSource
          ? 'Same-source HA images differ; a source SHA alone is not immutable compatibility evidence.'
          : 'Installed images differ from the mixed-version certificate.',
      );
  }
}
