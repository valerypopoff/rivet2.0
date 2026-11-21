import { recordingStorageContract } from './recording-storage-contract.mjs';
import {
  assertNoUnfinishedAutoscalerWork,
  journalForReleaseOperation,
  releaseOperationJournalName,
} from './release-operation-journal.mjs';

/** A vanished operator lease does not settle its durable release operation. */
export function assertRecordingReleaseSettled(configmaps, release, namespace, manifestDigest, now = Date.now) {
  const name = releaseOperationJournalName(release);
  const journals = configmaps.filter((item) => item.metadata?.name === name);
  const [journal] = journals;
  if (
    journals.length !== 1 ||
    journal.kind !== 'ConfigMap' ||
    journal.metadata?.namespace !== namespace ||
    (journal.metadata?.labels?.['app.kubernetes.io/instance'] !== undefined &&
      journal.metadata.labels['app.kubernetes.io/instance'] !== release) ||
    !journal.metadata.uid ||
    !journal.metadata.resourceVersion ||
    journal.metadata.deletionTimestamp
  )
    throw Error('Recording conversion requires a confirmed release operation journal.');
  const record = JSON.parse(journal.data?.record ?? 'null');
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw Error('Recording conversion requires a valid release operation journal.');
  assertNoUnfinishedAutoscalerWork(record);
  journalForReleaseOperation(
    { ...record, resourceVersion: journal.metadata.resourceVersion },
    'recording-recompression',
    { release, namespace },
    now,
  );
  if (record.manifestDigest !== manifestDigest)
    throw Error('Recording conversion requires a settled journal for the installed reader release.');
}

/** Check exact immutable images, including terminating pods and future readers. */
export function assertRecordingReaderInventory(manifest, resources, release) {
  const contract = recordingStorageContract(manifest.recordingStorage);
  if (!contract.readableEncodings.includes('br') || contract.coordinationProtocol !== 1)
    throw Error('Installed release does not support coordinated Brotli recording storage.');
  const images = new Set(
    ['api', 'executor'].map((name) => `${manifest.images[name].repository}@${manifest.images[name].digest}`),
  );
  let readers = 0;
  const ignored = new Set(['proxy', 'web', 'autoscaler', 'release-identity']);
  for (const item of resources) {
    if (item.metadata?.labels?.['app.kubernetes.io/instance'] !== release) continue;
    if (ignored.has(item.metadata?.labels?.['app.kubernetes.io/component'])) continue;
    if (item.kind === 'Pod' && ['Succeeded', 'Failed'].includes(item.status?.phase)) continue;
    if (
      item.kind === 'Job' &&
      item.status?.conditions?.some(
        (condition) => ['Complete', 'Failed'].includes(condition.type) && condition.status === 'True',
      )
    )
      continue;
    const template =
      item.kind === 'Pod'
        ? item
        : item.kind === 'CronJob'
          ? item.spec?.jobTemplate?.spec?.template
          : item.spec?.template;
    if (!template) continue;
    const containers = [...(template.spec?.containers ?? []), ...(template.spec?.initContainers ?? [])];
    const application = containers.filter((container) => !['vault-agent', 'vault-agent-init'].includes(container.name));
    if (!application.length) throw Error('An unrecognized workload could read recording storage.');
    for (const container of application) {
      if (!images.has(container.image))
        throw Error('An older, mutable or unknown recording reader is still installed.');
      readers++;
    }
  }
  if (!readers) throw Error('No installed recording readers were verified.');
}
