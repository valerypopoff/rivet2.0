import fs from 'node:fs';

const mode = process.argv[2];
const startedAtKey = 'RIVET_CI_JOB_STARTED_AT';

function append(filePath, line) {
  if (filePath) {
    fs.appendFileSync(filePath, `${line}\n`);
  }
}

function formatDuration(startedAt) {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

if (mode === 'start') {
  const label = process.argv.slice(3).join(' ').trim() || 'CI job';
  append(process.env.GITHUB_ENV, `${startedAtKey}=${Date.now()}`);
  console.log(`[ci-timing] Started ${label}.`);
} else if (mode === 'finish') {
  const label = process.argv.slice(3).join(' ').trim() || 'CI job';
  const startedAt = Number(process.env[startedAtKey]);
  if (!Number.isFinite(startedAt)) {
    throw new Error(`${startedAtKey} is missing; run job-timing.mjs start first.`);
  }
  const duration = formatDuration(startedAt);
  append(process.env.GITHUB_STEP_SUMMARY, `- **${label}:** ${duration}`);
  console.log(`[ci-timing] ${label} completed in ${duration}.`);
} else if (mode === 'finish-at') {
  const startedAt = Date.parse(process.argv[3] ?? '');
  const label = process.argv.slice(4).join(' ').trim() || 'CI workflow';
  if (!Number.isFinite(startedAt)) {
    throw new Error('finish-at requires an ISO-8601 start timestamp.');
  }
  const duration = formatDuration(startedAt);
  append(process.env.GITHUB_STEP_SUMMARY, `- **${label}:** ${duration}`);
  console.log(`[ci-timing] ${label} completed in ${duration}.`);
} else {
  throw new Error('Usage: node scripts/ci/job-timing.mjs <start|finish|finish-at> [timestamp] <label>');
}
