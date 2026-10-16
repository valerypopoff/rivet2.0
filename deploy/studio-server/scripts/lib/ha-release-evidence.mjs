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
];
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
  const baseline = mode === 'mixed' ? release.lineage?.predecessor?.images?.api : release.images.api;
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
      protocol: 1,
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
  if (
    !value ||
    value.protocol !== 1 ||
    !['bootstrap', 'mixed'].includes(value.mode) ||
    value.candidateSourceSha !== release.source.sha ||
    !equal(value.candidateImages, release.images) ||
    value.chartDigest !== release.chart.contentDigest ||
    value.failedRequests !== 0 ||
    !Number.isSafeInteger(value.requestSamples) ||
    value.requestSamples < 100 ||
    !Array.isArray(value.checks) ||
    new Set(value.checks).size !== HA_REQUIRED_CHECKS.length ||
    value.checks.length !== HA_REQUIRED_CHECKS.length ||
    !HA_REQUIRED_CHECKS.every((check) => value.checks?.includes(check))
  )
    throw new Error('HA compatibility evidence is incomplete or belongs to another candidate.');
  const previous = release.lineage?.predecessor;
  if (
    value.mode === 'mixed' &&
    (!previous ||
      value.predecessorSourceSha !== previous.sourceSha ||
      !equal(value.predecessorImages, previous.images) ||
      equal(previous.images, release.images))
  )
    throw new Error('HA mixed-version evidence does not match the exact predecessor.');
  return {
    protocol: 1,
    mode: value.mode,
    candidateSourceSha: value.candidateSourceSha,
    candidateImages: release.images,
    chartDigest: value.chartDigest,
    failedRequests: 0,
    requestSamples: value.requestSamples,
    checks: [...HA_REQUIRED_CHECKS],
    ...(value.mode === 'mixed' ? { predecessorSourceSha: previous.sourceSha, predecessorImages: previous.images } : {}),
  };
}

export function assertHaUpgradeEvidence(manifest, installed) {
  const evidence = assertHaReleaseEvidence(manifest.evidence?.ha, manifest);
  if (!installed) return;
  if (!installed.ha?.enabled) throw new Error('First HA conversion requires an explicit maintenance cutover.');
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
