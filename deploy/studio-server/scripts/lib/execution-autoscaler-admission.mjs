import { createHash } from 'node:crypto';

/** Only compatible runtime observations can explain a live-setting transition. */
export function executionAdmissionCapacity(pods) {
  if (!pods.length) throw Error('Execution admission capacity is unavailable.');
  if (
    pods.some(
      (p) =>
        !Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 10000 || !Number.isFinite(p.active) || p.active < 0,
    )
  )
    throw Error('Execution admission capacity is invalid.');
  const limits = new Set(pods.map((pod) => pod.limit));
  const modern = pods.filter((pod) => pod.admissionPolicy !== undefined);
  const limit = Math.min(...limits);
  if (!modern.length) {
    if (limits.size !== 1) throw Error('Execution admission limits differ; wait for the owned deployment.');
    return { limit, converging: false, revision: null };
  }
  const defaults = new Set(),
    scopes = new Set(),
    revisions = new Map();
  for (const pod of modern) {
    const p = pod.admissionPolicy;
    if (
      p?.protocol !== 1 ||
      p.mode !== 'enforce' ||
      typeof p.installation !== 'string' ||
      !/^[a-z0-9][a-z0-9./_-]{0,255}$/.test(p.installation) ||
      !Number.isSafeInteger(p.deploymentDefault) ||
      p.deploymentDefault < 1 ||
      p.deploymentDefault > 10000 ||
      typeof p.revision !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(p.revision) ||
      !['deployment', 'app-settings'].includes(p.source) ||
      typeof p.draining !== 'boolean' ||
      !Number.isSafeInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > 10000 ||
      p.limit !== pod.limit ||
      p.active !== pod.active ||
      !Number.isSafeInteger(p.active) ||
      p.active < 0 ||
      (p.source === 'deployment' && p.limit !== p.deploymentDefault)
    )
      throw Error('Execution runtime admission policy is invalid.');
    defaults.add(p.deploymentDefault);
    scopes.add(p.installation);
    const value = JSON.stringify([p.limit, p.source]);
    if (revisions.has(p.revision) && revisions.get(p.revision) !== value)
      throw Error('Execution settings revision reports conflicting capacity.');
    revisions.set(p.revision, value);
  }
  if (defaults.size !== 1 || scopes.size !== 1)
    throw Error('Execution deployment admission defaults or installation differ.');
  if (modern.length !== pods.length && (limits.size !== 1 || limit !== modern[0].admissionPolicy.deploymentDefault))
    throw Error('Legacy execution workers cannot confirm a live admission transition.');
  const revision = createHash('sha256')
    .update(
      JSON.stringify([
        [...scopes][0],
        [...defaults][0],
        [...revisions].sort(([a], [b]) => a.localeCompare(b)),
        modern.length === pods.length,
      ]),
    )
    .digest('hex');
  return { limit, converging: revisions.size > 1, revision };
}

export function admissionPolicySample(text, retirement) {
  const prefix = '# rivet-execution-policy ';
  const lines = text.split('\n').filter((line) => line.startsWith(prefix));
  if (!lines.length) return undefined;
  if (lines.length !== 1 || lines[0].length > 4096) throw Error('Execution policy sample is invalid.');
  const sample = JSON.parse(lines[0].slice(prefix.length));
  if (sample.incarnation !== retirement.incarnation || !sample.admission)
    throw Error('Execution policy process incarnation changed or its policy is unavailable.');
  executionAdmissionCapacity([
    { limit: sample.admission.limit, active: sample.admission.active, admissionPolicy: sample.admission },
  ]);
  return sample.admission;
}
