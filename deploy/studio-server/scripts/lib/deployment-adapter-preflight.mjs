import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export async function verifyReviewedRecoveryDependencies(root, dependencies) {
  if (!Array.isArray(dependencies) || !dependencies.length)
    throw Error('Preflight needs a nonempty reviewed dependency inventory.');
  for (const dependency of dependencies) {
    const file = path.resolve(root, dependency.path);
    if (
      !inside(root, file) ||
      !(await fs.lstat(file)).isFile() ||
      !inside(await fs.realpath(root), await fs.realpath(file)) ||
      !/^sha256:[a-f0-9]{64}$/.test(dependency.sha256 ?? '') ||
      digest(await fs.readFile(file)) !== dependency.sha256
    )
      throw Error('A reviewed local recovery dependency changed; prepare a new kit before maintenance.');
  }
}

/** Reusable local-only half of the reviewed backup adapter contract. This is
 * not deployment admission or a sandbox for arbitrary adapters. Its fixed
 * probes never select a cluster, connect to a DB or download recovery objects. */
export async function runDeploymentAdapterPreflight(
  { root, requirements, request, receiptPath },
  { command = execute, statfs = (directory) => fs.statfs(directory, { bigint: true }) } = {},
) {
  const directory = path.dirname(path.resolve(receiptPath));
  if (
    request?.stage !== 'preflight' ||
    request.formatVersion !== 1 ||
    !request.requestId ||
    !request.operationId ||
    !request.startedAt ||
    ['release', 'namespace', 'context', 'namespaceUid', 'installedManifestDigest'].some(
      (key) => request[key] !== requirements.installation[key],
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(request.candidateManifestDigest ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(request.valuesDigest ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(request.operationPlanDigest ?? '')
  )
    throw Error('Local preflight requires the reviewed installation, baseline and request identity.');
  if (
    !inside(root, directory) ||
    !(await fs.lstat(directory)).isDirectory() ||
    !inside(await fs.realpath(root), await fs.realpath(directory))
  )
    throw Error('Local preflight output escaped the private repository directory.');
  const initial = await fs.lstat(directory, { bigint: true });
  const checkedFile = async (name) => {
    const file = path.resolve(root, name);
    if (
      !inside(root, file) ||
      !(await fs.lstat(file)).isFile() ||
      !inside(await fs.realpath(root), await fs.realpath(file))
    )
      throw Error('A reviewed local dependency escaped the repository.');
    return file;
  };
  await verifyReviewedRecoveryDependencies(root, requirements.dependencies);
  const bounds = requirements.capacity;
  for (const key of ['databaseBytes', 'objectDeltaBytes', 'copies', 'reserveBytes'])
    if (!Number.isSafeInteger(bounds?.[key]) || bounds[key] <= 0)
      throw Error('Recovery capacity needs explicit positive reviewed bounds.');
  const requiredBytes =
    (BigInt(bounds.databaseBytes) + BigInt(bounds.objectDeltaBytes)) * BigInt(bounds.copies) +
    BigInt(bounds.reserveBytes);
  const space = await statfs(directory);
  const availableBytes = BigInt(space.bavail) * BigInt(space.bsize);
  if (availableBytes <= requiredBytes)
    throw Error('Insufficient local recovery headroom; maintenance has not started.');
  const scratch = path.join(directory, `.readiness-${randomUUID()}`);
  const sample = Buffer.from('Rivet local recovery read/write verification');
  let created = false;
  try {
    await fs.writeFile(scratch, sample, { flag: 'wx', mode: 0o600 });
    created = true;
    if (digest(await fs.readFile(scratch)) !== digest(sample)) throw Error('Local recovery scratch readback failed.');
  } finally {
    if (created)
      await fs.unlink(scratch).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }

  const tools = requirements.tools;
  if (
    !tools ||
    !path.isAbsolute(tools.helm) ||
    !path.isAbsolute(tools.kubectl) ||
    !path.isAbsolute(tools.cloudSqlProxy) ||
    !/^sha256:[a-f0-9]{64}$/.test(tools.postgresImageId ?? '')
  )
    throw Error('Local deployment tools and the cached PostgreSQL image must be explicitly pinned.');
  const probeFile = await checkedFile(requirements.probeScript);
  const configFile = await checkedFile(requirements.probeConfiguration);
  if (
    [probeFile, configFile].some(
      (file) => !requirements.dependencies.some((dependency) => path.resolve(root, dependency.path) === file),
    )
  )
    throw Error('Both local probe files must be in the reviewed dependency inventory.');
  // The child itself blocks direct networking. The scripts/configuration above
  // are checksum-pinned reviewed files, not arbitrary request-selected commands.
  const checks = [
    ['helm', tools.helm, ['version', '--short']],
    ['kubectl-client', tools.kubectl, ['version', '--client=true', '--output=json']],
    ['cloud-sql-proxy', tools.cloudSqlProxy, ['--version']],
    ['tar', 'tar', ['--version']],
    ['postgres-image', 'docker', ['image', 'inspect', tools.postgresImageId, '--format', '{{.Id}}']],
    [
      'operator-imports-and-browser',
      process.execPath,
      [path.join(root, '.yarn/releases/yarn-4.17.1.cjs'), 'node', probeFile, '--configuration', configFile],
    ],
  ];
  const evidence = [];
  // Preserve enough of the 60-second outer budget for failed-child shutdown.
  const deadline = Date.now() + 50_000;
  for (const [name, executable, args] of checks) {
    if (deadline - Date.now() <= 0) throw Error('Local readiness deadline reached; no maintenance follows.');
    let result;
    try {
      result = await command(executable, args, {
        cwd: root,
        windowsHide: true,
        // The shared outer supervisor bounds this stage and stops the entire
        // owned tree. An inner timeout that kills only this probe parent could
        // orphan its browser/SDK descendants before that supervisor can act.
        maxBuffer: 128 * 1024,
        env: { ...process.env, YARN_ENABLE_NETWORK: '0', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true' },
      });
    } catch (error) {
      // Child diagnostics belong in the adapter's private log, not ordinary CLI output.
      console.error(`Local readiness check failed: ${name}`, error);
      throw Error(`Local prerequisite ${name} failed; maintenance has not started.`);
    }
    if (name === 'postgres-image' && String(result.stdout).trim() !== tools.postgresImageId)
      throw Error('The local PostgreSQL recovery image identity changed.');
    if (name === 'operator-imports-and-browser') {
      let report;
      try {
        report = JSON.parse(String(result.stdout).trim());
      } catch {
        throw Error('Local operator probe returned invalid evidence.');
      }
      if (
        report.localOnly !== true ||
        report.imports !== true ||
        report.esbuild !== true ||
        report.browser !== true ||
        report.uiRunner !== true ||
        report.keyProtection !== true
      )
        throw Error('Local operator probe did not verify every required prerequisite.');
    }
    evidence.push({ name, passed: true });
  }
  const current = await fs.lstat(directory, { bigint: true });
  if (
    current.dev !== initial.dev ||
    current.ino !== initial.ino ||
    !current.isDirectory() ||
    !inside(await fs.realpath(root), await fs.realpath(directory))
  )
    throw Error('Local preflight directory identity changed.');
  await fs.writeFile(path.join(directory, 'dependencies.json'), JSON.stringify({ localOnly: true, checks: evidence }), {
    flag: 'wx',
    mode: 0o600,
  });
  await fs.writeFile(
    path.join(directory, 'capacity.json'),
    JSON.stringify({
      localOnly: true,
      requiredBytes: String(requiredBytes),
      availableBytes: String(availableBytes),
      bounds,
      scratchReadback: true,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const receipt = {
    ...request,
    kind: 'rivet-deployment-preflight',
    passed: true,
    checks: {
      dependencies: { passed: true, observed: true, evidence: 'dependencies.json' },
      capacity: { passed: true, observed: true, evidence: 'capacity.json' },
    },
  };
  await fs.writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  return { verified: true, localOnly: true, requiredBytes: String(requiredBytes), checks: evidence.length };
}
