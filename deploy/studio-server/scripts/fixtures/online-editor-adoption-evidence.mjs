import { onlineAdoptionEvents } from '../lib/online-editor-adoption-receipt.mjs';

export function onlineEditorAdoptionEvidence(installedManifestDigest, origin = 0) {
  const observed = {};
  const protectedRequests = [];
  for (const [index, [, , stage]] of onlineAdoptionEvents.entries()) {
    const start = origin + index * 300_000;
    const iso = (offset) => new Date(start + offset).toISOString();
    observed[stage] = {
      startedAt: iso(2_000),
      at: iso(65_000),
      before: { editor: 1, workflow: 1, webApp: 1 },
      after: { editor: 2, workflow: 2, webApp: 2 },
      freshLogin: true,
    };
    for (const transport of ['fresh-http1', 'pooled-http1', 'http2']) {
      protectedRequests.push({
        stage,
        transport,
        ...(transport === 'pooled-http1' ? { reusedConnection: true } : {}),
        fullBody: true,
        outcome: 'passed',
        recordingId: `${stage}-${transport}`,
        durationMs: 295_000,
        elapsedMs: 296_000,
        acceptedAt: iso(1_000),
        finishedAt: iso(297_000),
      });
    }
  }
  return {
    installedManifestDigest,
    traffic: { failures: [] },
    browser: { passed: true, unsavedEdit: true, savedByCandidate: true, newRun: true, reloads: 0, iframeReloads: 0 },
    observed,
    protectedRequests,
  };
}
