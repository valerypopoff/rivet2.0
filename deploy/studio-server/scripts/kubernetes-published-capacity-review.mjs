import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const safeStageNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const safeModeValues = new Set(['observe', 'certify']);
const safeStatusValues = new Set(['completed', 'failed']);
const safePhasePattern = /^[a-z][a-z-]{0,80}$/u;
const sensitiveTextPattern = /authorization|bearer|password|secret|token|rivet[_ -]?key|prompt|output/iu;
const supportedEvidenceVersion = 1;

function asRecord(value) {
  return value && !Array.isArray(value) && typeof value === 'object' ? value : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonnegativeFiniteNumber(value) {
  const numeric = finiteNumber(value);
  return numeric != null && numeric >= 0 ? numeric : null;
}

function safeText(value, fallback = 'Not reported') {
  if (typeof value !== 'string') return fallback;
  const normalized = value
    .replaceAll(/[\r\n\t]/gu, ' ')
    .replaceAll(/[[\]<>*_`]/gu, '\\$&')
    .trim();
  if (!normalized || normalized.length > 240 || sensitiveTextPattern.test(normalized)) return fallback;
  return normalized;
}

function formatNumber(value, suffix = '') {
  const numeric = finiteNumber(value);
  return numeric == null
    ? 'Not reported'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numeric)}${suffix}`;
}

function formatBytes(value) {
  const numeric = finiteNumber(value);
  if (numeric == null || numeric < 0) return 'Not reported';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unitIndex = 0;
  let scaled = numeric;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(scaled)} ${units[unitIndex]}`;
}

function maxFinite(values) {
  const finiteValues = values.map(nonnegativeFiniteNumber).filter((value) => value != null);
  return finiteValues.length === 0 ? null : Math.max(...finiteValues);
}

function getBaselineSnapshot(records) {
  return records.find((snapshot) => snapshot.baseline === true) ?? null;
}

function summarizeRestartIncrease(records, observed) {
  const baseline = getBaselineSnapshot(records);
  if (!baseline) return null;
  const baselineCounts = asRecord(baseline.restartCountsByPod) ?? {};
  const maximaByPod = new Map();
  let foundObservedCounter = false;
  for (const snapshot of observed) {
    for (const [podName, rawCount] of Object.entries(asRecord(snapshot.restartCountsByPod) ?? {})) {
      const count = nonnegativeFiniteNumber(rawCount);
      if (count == null) continue;
      foundObservedCounter = true;
      maximaByPod.set(podName, Math.max(maximaByPod.get(podName) ?? 0, count));
    }
  }
  if (!foundObservedCounter) return null;
  return [...maximaByPod.entries()].reduce((total, [podName, maximum]) => {
    return total + Math.max(0, maximum - (nonnegativeFiniteNumber(baselineCounts[podName]) ?? 0));
  }, 0);
}

function summarizeNewPodObservations(records, observed, key) {
  const baseline = getBaselineSnapshot(records);
  if (!baseline) return null;
  const baselineNames = new Set(
    Array.isArray(baseline[key]) ? baseline[key].filter((value) => typeof value === 'string') : [],
  );
  const observedNames = new Set();
  let foundObservedList = false;
  for (const snapshot of observed) {
    if (!Array.isArray(snapshot[key])) continue;
    foundObservedList = true;
    for (const podName of snapshot[key]) {
      if (typeof podName === 'string' && !baselineNames.has(podName)) observedNames.add(podName);
    }
  }
  return foundObservedList ? observedNames.size : null;
}

function markdownTable(headers, rows) {
  const escapedHeaders = headers.map((header) => safeText(header, 'Unknown').replaceAll('|', '\\|'));
  const escapedRows = rows.map((row) =>
    row.map((value) => safeText(value, 'Not reported').replaceAll('|', '\\|').replaceAll('\n', ' ')),
  );
  return [
    `| ${escapedHeaders.join(' | ')} |`,
    `| ${escapedHeaders.map(() => '---').join(' | ')} |`,
    ...escapedRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function summarizeStages(report) {
  const stages = Array.isArray(report?.stages) ? report.stages : [];
  return stages
    .map((rawStage) => {
      const stage = asRecord(rawStage);
      const name = safeStageNamePattern.test(String(stage?.name ?? '')) ? String(stage.name) : 'Unknown stage';
      const scenario = safeText(stage?.scenario, 'Unknown');
      const outcomes = asRecord(stage?.outcomes) ?? {};
      const outcomeSummary = Object.entries(outcomes)
        .filter(([key, value]) => /^[a-z][a-z-]{0,30}$/u.test(key) && finiteNumber(value) != null)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}: ${formatNumber(value)}`)
        .join(', ');
      const timings = asRecord(stage?.requestTimings);
      return [
        name,
        scenario,
        formatNumber(timings?.p50Ms, ' ms'),
        formatNumber(timings?.p95Ms, ' ms'),
        formatNumber(timings?.p99Ms, ' ms'),
        outcomeSummary || 'Not reported',
      ];
    })
    .filter((row) => row[0] !== 'Unknown stage');
}

function summarizeSnapshots(snapshots) {
  const records = Array.isArray(snapshots) ? snapshots.map(asRecord).filter(Boolean) : [];
  const observed = records.filter((snapshot) => snapshot.baseline !== true);
  const prometheus = observed.map((snapshot) => asRecord(snapshot.prometheus)).filter(Boolean);
  return {
    totalSamples: records.length,
    observedSamples: observed.length,
    maxActiveRuns: maxFinite(observed.map((snapshot) => finiteNumber(asRecord(snapshot.metrics)?.activeRuns))),
    maxAdmissionLimit: maxFinite(observed.map((snapshot) => finiteNumber(asRecord(snapshot.metrics)?.admissionLimit))),
    maxRecordingQueueDepth: maxFinite(
      observed.map((snapshot) => finiteNumber(asRecord(snapshot.metrics)?.recordingQueueDepth)),
    ),
    maxRecordingDrops: maxFinite(observed.map((snapshot) => finiteNumber(snapshot.recordingDropsObserved))),
    restartCount: summarizeRestartIncrease(records, observed),
    oomCount: summarizeNewPodObservations(records, observed, 'oomKilledPods'),
    evictionCount: summarizeNewPodObservations(records, observed, 'evictedPods'),
    prometheusSamples: prometheus.filter((snapshot) => snapshot.available === true).length,
    maxMemoryHighWaterBytes: maxFinite(
      prometheus.map((snapshot) => finiteNumber(asRecord(snapshot.values)?.memoryHighWaterBytes)),
    ),
    maxNodeEphemeralHighWaterBytes: maxFinite(
      prometheus.map((snapshot) => finiteNumber(asRecord(snapshot.values)?.nodeEphemeralHighWaterBytes)),
    ),
    maxDownstreamConcurrency: maxFinite(
      prometheus.map((snapshot) => finiteNumber(asRecord(snapshot.values)?.downstreamConcurrency)),
    ),
  };
}

function summarizeCertificate(evidence) {
  const certificate = asRecord(evidence?.certificate) ?? {};
  const failures = Array.isArray(certificate.failures) ? certificate.failures : [];
  return {
    evaluated: certificate.evaluated === true,
    passed: certificate.passed === true,
    findingCount: failures.length,
  };
}

function createUnavailableReview(message) {
  return [
    '# Published capacity calibration review',
    '',
    '## Evidence status',
    '',
    message,
    '',
    '## Required follow-up',
    '',
    '- Retrieve the sanitized `capacity-report.json` from the same workflow attempt.',
    '- Confirm cleanup completed before retrying the protected staging run.',
  ].join('\n');
}

export function createCapacityCalibrationReview(evidence) {
  const evidenceRecord = asRecord(evidence);
  if (!evidenceRecord)
    return createUnavailableReview(
      'No readable capacity evidence was available. This run cannot support sizing, threshold, or promotion decisions.',
    );
  if (evidenceRecord.version !== supportedEvidenceVersion)
    return createUnavailableReview(
      'The capacity evidence uses an unsupported or missing schema version. This run cannot support sizing, threshold, or promotion decisions.',
    );

  const mode = safeModeValues.has(evidenceRecord.mode) ? evidenceRecord.mode : 'unknown';
  const status = safeStatusValues.has(evidenceRecord.status) ? evidenceRecord.status : 'unknown';
  const phase = safePhasePattern.test(String(evidenceRecord.phase ?? '')) ? evidenceRecord.phase : 'unknown';
  const certificate = summarizeCertificate(evidenceRecord);
  const cleanup = asRecord(evidenceRecord.cleanup) ?? {};
  const report = asRecord(evidenceRecord.report);
  const snapshots = summarizeSnapshots(evidenceRecord.snapshots);
  const stageRows = summarizeStages(report);
  const lines = [
    '# Published capacity calibration review',
    '',
    'This is a sanitized observation summary. It never authorizes automatic changes to resource limits, admission ceilings, HPA bounds, or promotion.',
    '',
    '## Evidence status',
    '',
    markdownTable(
      ['Field', 'Observation'],
      [
        ['Run mode', mode],
        ['Execution status', status],
        ['Last completed phase', safeText(phase, 'Unknown')],
        ['Capacity policy evaluated', certificate.evaluated ? 'Yes' : 'No'],
        [
          'Policy result',
          certificate.evaluated ? (certificate.passed ? 'Passed' : 'Findings recorded') : 'Not evaluated',
        ],
        ['Policy finding count', formatNumber(certificate.findingCount)],
        ['Cleanup', cleanup.succeeded === true ? 'Completed' : 'Incomplete or failed'],
      ],
    ),
    '',
    '## Stage observations',
    '',
    stageRows.length > 0
      ? markdownTable(['Stage', 'Scenario', 'P50', 'P95', 'P99', 'Outcomes'], stageRows)
      : 'No complete worker report was available. Do not make sizing decisions from this run.',
    '',
    '## Observed high-water and safety signals',
    '',
    markdownTable(
      ['Signal', 'Observed maximum or count'],
      [
        [
          'Samples (non-baseline / total)',
          `${formatNumber(snapshots.observedSamples)} / ${formatNumber(snapshots.totalSamples)}`,
        ],
        ['Prometheus samples available', formatNumber(snapshots.prometheusSamples)],
        ['Active published runs', formatNumber(snapshots.maxActiveRuns)],
        ['Admission limit', formatNumber(snapshots.maxAdmissionLimit)],
        ['Recording queue depth', formatNumber(snapshots.maxRecordingQueueDepth)],
        ['Recording drops', formatNumber(snapshots.maxRecordingDrops)],
        ['Execution container restarts', formatNumber(snapshots.restartCount)],
        ['Execution OOM-kill observations', formatNumber(snapshots.oomCount)],
        ['Execution eviction observations', formatNumber(snapshots.evictionCount)],
        ['Memory high-water', formatBytes(snapshots.maxMemoryHighWaterBytes)],
        ['Node-ephemeral high-water', formatBytes(snapshots.maxNodeEphemeralHighWaterBytes)],
        ['Downstream concurrency', formatNumber(snapshots.maxDownstreamConcurrency)],
      ],
    ),
    '',
    '## Required human decisions',
    '',
    '- Keep this report with the immutable candidate image set and provider dashboards; one observation run is not a sizing decision.',
    '- Confirm the Prometheus queries describe only the intended proxy/execution workload and each reported value is one finite aggregate.',
    '- Compare several representative runs before proposing resource requests/limits, writable-volume sizes, admission ceilings, or HPA bounds.',
    '- Set explicit p95 and overload objectives in normal review. Treat the configured certificate thresholds as guardrails, not observed production SLOs.',
    '- Do not run the hosted-Evaluation saturation extension until the published-endpoint SLO envelope is approved from retained public-capacity evidence.',
  ];
  if (mode === 'observe') {
    lines.push(
      '',
      '## Observe-mode boundary',
      '',
      'Observe mode records policy findings but intentionally does not turn them into a passing certificate and must not promote candidate images.',
    );
  }
  if (mode === 'unknown' || status !== 'completed' || cleanup.succeeded !== true || !report) {
    lines.push(
      '',
      '## Incomplete evidence',
      '',
      'This attempt is diagnostic only. Resolve the failed phase or cleanup state, then retain a fresh complete observation before comparing capacity values.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function writeCapacityCalibrationReview({ inputFile, outputFile }) {
  let evidence = null;
  try {
    evidence = JSON.parse(await fs.readFile(inputFile, 'utf8'));
  } catch {
    // This runs from an always() workflow step: a missing or malformed report is
    // useful diagnostic evidence, but must not mask the capacity command result.
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, createCapacityCalibrationReview(evidence), 'utf8');
}

async function main() {
  const [inputFile, outputFile] = process.argv.slice(2);
  if (!inputFile || !outputFile) {
    throw new Error('Usage: node kubernetes-published-capacity-review.mjs <capacity-report.json> <capacity-review.md>');
  }
  await writeCapacityCalibrationReview({ inputFile: path.resolve(inputFile), outputFile: path.resolve(outputFile) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
