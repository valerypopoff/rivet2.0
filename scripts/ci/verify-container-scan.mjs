import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assessContainerReport, candidateScanTargets, scannerImage } from './scan-container-images.mjs';

/** Reassess the sanitized evidence against the final manifest, rather than
 * trusting a successful producer or an unbound passed:true receipt. */
export function verifyCandidateScanEvidence(manifest, service, sourceSha, evidence, now = Date.now()) {
  const targets = candidateScanTargets(manifest, service, sourceSha);
  assert.deepEqual(
    evidence.result,
    {
      formatVersion: 1,
      service,
      sourceSha,
      image: targets[0].image,
      scannerImage,
      passed: true,
      failures: [],
    },
    'Component scan does not match this release',
  );
  assert.deepEqual(
    Object.keys(evidence.platforms).sort(),
    targets.map((t) => t.platform).sort(),
    'Scan platform set differs',
  );
  for (const target of targets) {
    const { report, assessment } = evidence.platforms[target.platform];
    const scannedAt = Date.parse(assessment.scannedAt);
    assert.ok(
      Number.isFinite(scannedAt) && scannedAt <= now + 300_000 && now - scannedAt <= 48 * 3_600_000,
      'Scan timestamp is missing, stale or future-dated',
    );
    const result = assessContainerReport(report, { ...target, database: assessment.database, now });
    assert.equal(result.blockers.length, 0, 'Blocking vulnerabilities remain');
    assert.deepEqual(
      assessment,
      {
        formatVersion: 1,
        scannedAt: assessment.scannedAt,
        scannerImage,
        image: target.image,
        ...result,
      },
      'Assessment differs from its report or release identity',
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: Object.fromEntries(['manifest', 'service', 'source-sha', 'input'].map((key) => [key, { type: 'string' }])),
  });
  assert.ok(values.manifest && values.input && values.service, '--manifest, --service and --input are required');
  const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
  const manifest = await read(values.manifest);
  const sourceSha = values['source-sha'] ?? process.env.GITHUB_SHA;
  const targets = candidateScanTargets(manifest, values.service, sourceSha);
  const expectedDirectories = targets.map((t) => t.platform.replace('/', '-')).sort();
  assert.deepEqual(
    (await fs.readdir(values.input)).sort(),
    ['result.json', ...expectedDirectories].sort(),
    'Unexpected or missing platform evidence',
  );
  const platforms = {};
  for (const target of targets) {
    const directory = path.join(values.input, target.platform.replace('/', '-'));
    platforms[target.platform] = {
      report: await read(path.join(directory, 'trivy.json')),
      assessment: await read(path.join(directory, 'assessment.json')),
    };
  }
  verifyCandidateScanEvidence(manifest, values.service, sourceSha, {
    result: await read(path.join(values.input, 'result.json')),
    platforms,
  });
  console.log(`Verified ${values.service}: every scanned digest/platform matches the candidate release.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[container-security] ${error.message}`);
    process.exitCode = 1;
  });
}
