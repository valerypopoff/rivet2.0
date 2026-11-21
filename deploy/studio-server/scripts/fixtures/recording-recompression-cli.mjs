import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  promoteStudioServerReleaseManifest,
} from '../lib/studio-server-release-manifest.mjs';
import { releaseOperationJournalName } from '../lib/release-operation-journal.mjs';

const directory = process.env.RIVET_RECOMPRESSION_CLI_FIXTURE;
if (!directory) throw Error('This preload requires its owned recompression fixture directory.');
const release = 'rivet',
  namespace = 'fixture';
const images = Object.fromEntries(
  ['api', 'executor', 'web', 'proxy'].map((name, index) => [
    name,
    {
      repository: `example.invalid/recompression/${name}`,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    },
  ]),
);
const manifest = promoteStudioServerReleaseManifest(
  createStudioServerReleaseManifest({
    rootDir: fileURLToPath(new URL('../../../../', import.meta.url)),
    source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: 'a'.repeat(40) },
    images,
    createdAt: '2026-01-01T00:00:00Z',
    candidateEvidence: { workflow: 'Local fixture', runId: '1', runAttempt: 1 },
  }),
  { promotionEvidence: { workflow: 'Local fixture', runId: '1', runAttempt: 1 }, promotedAt: '2026-01-01T00:00:01Z' },
);
const digest = getStudioServerReleaseManifestDigest(manifest);
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
childProcess.execFileSync = (program, args, options) => {
  if (program !== 'kubectl') throw Error('Unexpected external command in recompression fixture.');
  if (
    args[0] !== '--context' ||
    args[1] !== 'fixture-context' ||
    args[2] !== '--namespace' ||
    args[3] !== namespace ||
    args[5] !== 'get'
  )
    throw Error('Unexpected Kubernetes fixture command.');
  const resource = args[6];
  let items;
  if (resource === 'configmaps') {
    items = [
      {
        kind: 'ConfigMap',
        metadata: { name: 'rivet-release-identity', namespace, labels: { 'app.kubernetes.io/instance': release } },
        data: { 'release-manifest-digest': digest },
      },
      {
        kind: 'ConfigMap',
        metadata: {
          name: releaseOperationJournalName(release),
          namespace,
          uid: 'fixture-journal',
          resourceVersion: '1',
        },
        data: {
          record: JSON.stringify({
            autoscalingProtocol: 1,
            release,
            namespace,
            phase: 'complete',
            leaseExpiresAt: 0,
            token: 'fixture',
            runner: 'fixture',
            manifestDigest: digest,
          }),
        },
      },
    ];
  } else if (resource === 'pods,deployments,statefulsets,jobs,cronjobs') {
    items = [
      {
        kind: 'Pod',
        metadata: { name: 'fixture-api', namespace, labels: { 'app.kubernetes.io/instance': release } },
        spec: {
          containers: [
            {
              name: 'api',
              image: process.env.RIVET_RECOMPRESSION_CLI_OLD_READER
                ? 'example.invalid/old:tag'
                : `${images.api.repository}@${images.api.digest}`,
            },
          ],
        },
        status: { phase: 'Running' },
      },
    ];
  } else throw Error('Unexpected Kubernetes fixture resource.');
  fs.appendFileSync(path.join(directory, 'kube-reads.jsonl'), JSON.stringify({ resource }) + '\n');
  return options?.encoding ? JSON.stringify({ items }) : Buffer.from(JSON.stringify({ items }));
};
syncBuiltinESMExports();
