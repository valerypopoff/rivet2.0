import { containerStorageIdentity } from './container-server-config.mjs';
import { ensurePortAvailable } from './docker-launcher.mjs';

export const applicationServices = ['proxy', 'web', 'backend', 'execution'];

/** Only an installation-owned predecessor worker may be retired. Never remove
 * its named volumes: canonical evaluation evidence remains in PostgreSQL/S3. */
export async function retireLegacyEvaluationContainers(config, docker, containers) {
  const workers = containers.filter(
    (container) => container.Config?.Labels?.['com.docker.compose.service'] === 'evaluation',
  );
  for (const container of workers) {
    const labels = container.Config?.Labels ?? {};
    if (
      labels['com.docker.compose.project'] !== config.project ||
      labels['rivet.dev/container-installation'] !== config.project ||
      labels['rivet.dev/storage-identity'] !== containerStorageIdentity(config) ||
      (labels['rivet.dev/deployment-stage'] && labels['rivet.dev/deployment-stage'] !== config.stage) ||
      !/^[a-f0-9]{12,64}$/.test(container.Id ?? '')
    )
      throw new Error('Refusing to retire an unverified legacy evaluation container.');
  }
  for (const container of workers) {
    await docker(['stop', '--time', '150', container.Id]);
    await docker(['rm', container.Id]);
  }
}

export async function stopContainerInstallation(config, compose) {
  await compose(['stop', '--timeout', '150', ...applicationServices]);
  // Persistence must stay available while accepted application writes drain.
  if (config.local) await compose(['stop', '--timeout', '150', 'postgres', 'minio']);
}

/** A failed first launch has a pending receipt but no successful release yet. */
export function assertContainerDeploymentEvidence(config, containers, { selectedDigest, installedDigest, pending }) {
  if (
    pending &&
    (pending.project !== config.project ||
      pending.storageIdentity !== containerStorageIdentity(config) ||
      (config.stage !== 'dev' && pending.digest !== selectedDigest))
  )
    throw new Error('An unfinished deployment must be repaired with the same target and immutable manifest.');
  if (config.stage === 'dev') {
    if (installedDigest || containers.some((item) => item.Config.Labels['rivet.dev/release-manifest-digest']))
      throw new Error('An immutable deployment cannot be adopted by the development launcher.');
    return;
  }
  if (
    !installedDigest &&
    !pending &&
    containers.some((item) => !['postgres', 'minio'].includes(item.Config.Labels['com.docker.compose.service']))
  )
    throw new Error('Installed release evidence is missing; refusing an unidentified deployment.');
  const allowed = [selectedDigest, ...(installedDigest ? [installedDigest] : [])];
  if (containers.some((item) => !allowed.includes(item.Config.Labels['rivet.dev/release-manifest-digest'])))
    throw new Error('Installed containers do not match the recorded or selected immutable release.');
}

export async function assertContainerInstallationOwned(config, docker, model) {
  const found = await docker(
    ['ps', '-a', '--filter', `label=com.docker.compose.project=${config.project}`, '--format', '{{.ID}}'],
    { capture: true },
  );
  const ids = found.stdout.trim().split(/\s+/).filter(Boolean);
  const containers = ids.length ? JSON.parse((await docker(['inspect', ...ids], { capture: true })).stdout) : [];
  for (const container of containers) {
    const labels = container.Config?.Labels ?? {};
    if (
      !Object.hasOwn(model.services, labels['com.docker.compose.service'] ?? '') &&
      labels['com.docker.compose.service'] !== 'evaluation'
    )
      throw new Error('Compose project contains an unexpected service; refusing migration or shutdown.');
    if (['migrate', 'prepare-volumes'].includes(labels['com.docker.compose.service']) && container.State?.Running)
      throw new Error(
        'A deployment preparation task is still running; resolve its outcome before another launch or shutdown.',
      );
    if (labels['rivet.dev/deployment-stage'] && labels['rivet.dev/deployment-stage'] !== config.stage)
      throw new Error('Compose project belongs to another deployment stage.');
    if (labels['rivet.dev/container-installation'] !== config.project)
      throw new Error('Compose project contains a foreign container; refusing adoption or shutdown.');
    if (labels['rivet.dev/storage-identity'] !== containerStorageIdentity(config))
      throw new Error(
        'Storage coordinates or credentials changed. Reconcile the existing installation explicitly; no containers were stopped.',
      );
  }
  const volumes = await docker(['volume', 'ls', '--format', '{{.Name}}'], { capture: true });
  const expected = new Set(Object.keys(model.volumes).map((name) => `${config.project}_${name}`));
  for (const name of volumes.stdout
    .trim()
    .split(/\s+/)
    .filter((name) => expected.has(name))) {
    const volume = JSON.parse((await docker(['volume', 'inspect', name], { capture: true })).stdout)[0];
    if (
      volume.Labels?.['rivet.dev/container-installation'] !== config.project ||
      volume.Labels?.['rivet.dev/storage-identity'] !== containerStorageIdentity(config)
    )
      throw new Error('Compose project contains a foreign or changed volume; refusing adoption.');
  }
  const networks = (await docker(['network', 'ls', '--format', '{{.Name}}'], { capture: true })).stdout
    .trim()
    .split(/\s+/);
  if (networks.includes(`${config.project}_default`)) {
    const network = JSON.parse(
      (await docker(['network', 'inspect', `${config.project}_default`], { capture: true })).stdout,
    )[0];
    if (
      network.Labels?.['rivet.dev/container-installation'] !== config.project ||
      network.Labels?.['rivet.dev/storage-identity'] !== containerStorageIdentity(config)
    )
      throw new Error('Compose network is foreign or its storage binding changed; refusing adoption.');
  }
  return containers;
}

/** Stop producers before running DDL. Failure leaves application admission closed;
 * never automatically run old images against a potentially advanced schema. */
export async function startContainerInstallation(
  config,
  compose,
  checkPort = () =>
    ensurePortAvailable(Number(config.port), {
      envFileLabel: 'the shared .env',
      label: 'container-server',
      portVariable: 'RIVET_PORT',
      host: '127.0.0.1',
    }),
) {
  await compose(['stop', '--timeout', '150', ...applicationServices]);
  await checkPort();
  if (config.local) await compose(['up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'minio']);
  await compose(['run', '--rm', '--no-deps', 'prepare-volumes']);
  // Exit 75 is the private, read-only verified-restore preparation outcome.
  // Unknown acknowledgements and every other migration failure still block startup.
  const preparation = await compose(['run', '--rm', '--no-deps', 'migrate'], { acceptedExitCodes: [75] });
  const restoreRecovery = preparation?.exitCode === 75;
  try {
    await compose([
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      config.stage === 'dev' ? '1200' : '300',
      ...applicationServices,
    ]);
  } catch (startupError) {
    // A failed readiness wait may still have started healthy producers. Drain
    // the selected generation, keeping persistence alive and the pending receipt.
    try {
      await compose(['stop', '--timeout', '150', ...applicationServices]);
    } catch (drainError) {
      throw new AggregateError(
        [startupError, drainError],
        'Startup failed and application drain could not be confirmed. Inspect the owned installation before recovery.',
      );
    }
    throw startupError;
  }
  return { restoreRecovery };
}
