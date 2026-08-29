import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STUDIO_SERVER_RELEASE_MANIFEST_VERSION = 1;
export const STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS = ['proxy', 'web', 'api', 'executor'];

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sourceShaPattern = /^[a-f0-9]{40}$/;

function requiredString(value, description) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[studio-server-release-manifest] ${description} is required`);
  }
  return value.trim();
}

function positiveInteger(value, description) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[studio-server-release-manifest] ${description} must be a positive integer`);
  }
  return value;
}

function sha256Digest(value, description) {
  const digest = requiredString(value, description).toLowerCase();
  if (!digestPattern.test(digest)) {
    throw new Error(`[studio-server-release-manifest] ${description} must be a sha256 digest`);
  }
  return digest;
}

function assertTimestamp(value, description) {
  const timestamp = requiredString(value, description);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`[studio-server-release-manifest] ${description} must be an ISO timestamp`);
  }
  return timestamp;
}

function assertEvidence(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[studio-server-release-manifest] ${description} is required`);
  }
  return {
    workflow: requiredString(value.workflow, `${description}.workflow`),
    runId: requiredString(value.runId, `${description}.runId`),
    runAttempt: positiveInteger(value.runAttempt, `${description}.runAttempt`),
  };
}

function assertImages(images) {
  if (!images || typeof images !== 'object' || Array.isArray(images)) {
    throw new Error('[studio-server-release-manifest] images is required');
  }

  const normalized = {};
  for (const component of STUDIO_SERVER_RELEASE_IMAGE_COMPONENTS) {
    const image = images[component];
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new Error(`[studio-server-release-manifest] images.${component} is required`);
    }
    const repository = requiredString(image.repository, `images.${component}.repository`);
    const digest = sha256Digest(image.digest, `images.${component}.digest`);
    normalized[component] = { repository, digest };
  }
  return normalized;
}

/** Read the source-owned schema contract without a second hard-coded version. */
export function readManagedWorkflowSchemaReleaseContract(rootDir) {
  const sourcePath = path.join(
    rootDir,
    'packages',
    'studio-server-api',
    'src',
    'routes',
    'workflows',
    'managed',
    'schema-migrations.ts',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const currentMatch = source.match(/export const CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION = (\d+);/);
  const minimumMatch = source.match(
    /export const MINIMUM_ROLLBACK_COMPATIBLE_MANAGED_WORKFLOW_SCHEMA_VERSION = (\d+);/,
  );
  if (!currentMatch || !minimumMatch) {
    throw new Error(
      `[studio-server-release-manifest] Could not read the managed workflow schema release contract from ${sourcePath}`,
    );
  }
  const version = Number(currentMatch[1]);
  const minimumRollbackCompatibleVersion = Number(minimumMatch[1]);
  positiveInteger(version, 'managed workflow schema version');
  positiveInteger(minimumRollbackCompatibleVersion, 'managed workflow schema minimum rollback-compatible version');
  if (minimumRollbackCompatibleVersion > version) {
    throw new Error(
      '[studio-server-release-manifest] Managed workflow schema minimum rollback-compatible version cannot exceed the current version',
    );
  }
  return { version, minimumRollbackCompatibleVersion };
}

function listChartFiles(chartDirectory, relativeDirectory = '') {
  return fs
    .readdirSync(path.join(chartDirectory, relativeDirectory), { withFileTypes: true })
    .sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1))
    .flatMap((entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return listChartFiles(chartDirectory, relativePath);
      if (entry.isFile()) return [relativePath];
      throw new Error(`[studio-server-release-manifest] Helm chart contains unsupported entry ${relativePath}`);
    });
}

function getChartContentDigest(chartDirectory) {
  const hash = createHash('sha256');
  for (const relativePath of listChartFiles(chartDirectory)) {
    const canonicalPath = relativePath.split(path.sep).join('/');
    const contents = fs.readFileSync(path.join(chartDirectory, relativePath), 'utf8').replace(/\r\n/g, '\n');
    hash.update(canonicalPath);
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function readHelmChartIdentity(rootDir) {
  const chartDirectory = path.join(rootDir, 'deploy', 'studio-server', 'helm');
  const chartPath = path.join(chartDirectory, 'Chart.yaml');
  const chart = fs.readFileSync(chartPath, 'utf8');
  const name = chart.match(/^name:\s*(\S+)\s*$/m)?.[1];
  const version = chart.match(/^version:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  return {
    name: requiredString(name, 'Helm chart name'),
    version: requiredString(version, 'Helm chart version'),
    contentDigest: getChartContentDigest(chartDirectory),
  };
}

export function assertStudioServerReleaseManifest(manifest, { requirePromoted = false } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('[studio-server-release-manifest] manifest must be an object');
  }
  if (manifest.formatVersion !== STUDIO_SERVER_RELEASE_MANIFEST_VERSION) {
    throw new Error(`[studio-server-release-manifest] formatVersion must be ${STUDIO_SERVER_RELEASE_MANIFEST_VERSION}`);
  }
  if (!['candidate', 'promoted'].includes(manifest.state)) {
    throw new Error('[studio-server-release-manifest] state must be candidate or promoted');
  }
  if (requirePromoted && manifest.state !== 'promoted') {
    throw new Error(
      '[studio-server-release-manifest] Production deployment requires a promoted release manifest, not a candidate manifest',
    );
  }

  const source = manifest.source ?? {};
  const sha = requiredString(source.sha, 'source.sha').toLowerCase();
  if (!sourceShaPattern.test(sha)) {
    throw new Error('[studio-server-release-manifest] source.sha must be a 40-character lowercase Git commit');
  }
  const chart = manifest.chart ?? {};
  const database = manifest.database?.managedWorkflowSchema ?? {};
  const schemaVersion = positiveInteger(database.version, 'database.managedWorkflowSchema.version');
  const minimumRollbackCompatibleVersion = positiveInteger(
    database.minimumRollbackCompatibleVersion,
    'database.managedWorkflowSchema.minimumRollbackCompatibleVersion',
  );
  if (minimumRollbackCompatibleVersion > schemaVersion) {
    throw new Error(
      '[studio-server-release-manifest] database.managedWorkflowSchema.minimumRollbackCompatibleVersion cannot exceed version',
    );
  }

  const evidence = manifest.evidence ?? {};
  const normalized = {
    formatVersion: STUDIO_SERVER_RELEASE_MANIFEST_VERSION,
    state: manifest.state,
    createdAt: assertTimestamp(manifest.createdAt, 'createdAt'),
    source: {
      repository: requiredString(source.repository, 'source.repository'),
      ref: requiredString(source.ref, 'source.ref'),
      sha,
    },
    chart: {
      name: requiredString(chart.name, 'chart.name'),
      version: requiredString(chart.version, 'chart.version'),
      contentDigest: sha256Digest(chart.contentDigest, 'chart.contentDigest'),
    },
    database: {
      managedWorkflowSchema: {
        version: schemaVersion,
        minimumRollbackCompatibleVersion,
      },
    },
    images: assertImages(manifest.images),
    evidence: {
      candidate: assertEvidence(evidence.candidate, 'evidence.candidate'),
      ...(manifest.state === 'promoted'
        ? {
            promotion: {
              ...assertEvidence(evidence.promotion, 'evidence.promotion'),
              promotedAt: assertTimestamp(evidence.promotion?.promotedAt, 'evidence.promotion.promotedAt'),
            },
          }
        : {}),
    },
  };
  return normalized;
}

export function assertReleaseManifestMatchesCurrentChart(manifest, rootDir) {
  const release = assertStudioServerReleaseManifest(manifest, { requirePromoted: true });
  const currentChart = readHelmChartIdentity(rootDir);
  if (
    release.chart.name !== currentChart.name ||
    release.chart.version !== currentChart.version ||
    release.chart.contentDigest !== currentChart.contentDigest
  ) {
    throw new Error(
      `[studio-server-release-manifest] The current Helm chart (${currentChart.name} ${currentChart.version} ${currentChart.contentDigest}) does not match release manifest chart (${release.chart.name} ${release.chart.version} ${release.chart.contentDigest}). Check out the matching release source before deploying.`,
    );
  }
  return release;
}

/**
 * A release artifact is meaningful only alongside the exact source revision
 * that created its chart, migration contract, and deployment tool. The caller
 * resolves the checkout identity because this module deliberately has no Git
 * process dependency.
 */
export function assertReleaseManifestMatchesCurrentSource(manifest, currentSourceSha) {
  const release = assertStudioServerReleaseManifest(manifest, { requirePromoted: true });
  const checkoutSha = requiredString(currentSourceSha, 'current source SHA').toLowerCase();
  if (!sourceShaPattern.test(checkoutSha)) {
    throw new Error('[studio-server-release-manifest] current source SHA must be a 40-character Git commit');
  }
  if (release.source.sha !== checkoutSha) {
    throw new Error(
      `[studio-server-release-manifest] The current checkout (${checkoutSha}) does not match release manifest source (${release.source.sha}). Check out the manifest source before deploying.`,
    );
  }
  return release;
}

export function createStudioServerReleaseManifest({
  rootDir,
  source,
  images,
  candidateEvidence,
  createdAt = new Date().toISOString(),
}) {
  const schema = readManagedWorkflowSchemaReleaseContract(rootDir);
  const chart = readHelmChartIdentity(rootDir);
  return assertStudioServerReleaseManifest({
    formatVersion: STUDIO_SERVER_RELEASE_MANIFEST_VERSION,
    state: 'candidate',
    createdAt,
    source,
    chart,
    database: { managedWorkflowSchema: schema },
    images,
    evidence: { candidate: candidateEvidence },
  });
}

export function promoteStudioServerReleaseManifest(
  manifest,
  { promotionEvidence, promotedAt = new Date().toISOString() } = {},
) {
  const candidate = assertStudioServerReleaseManifest(manifest);
  return assertStudioServerReleaseManifest(
    {
      ...candidate,
      state: 'promoted',
      evidence: {
        ...candidate.evidence,
        promotion: { ...promotionEvidence, promotedAt },
      },
    },
    { requirePromoted: true },
  );
}

function releaseValuesFor({ manifest, chart, images, compatibility, migrationJobEnabled }) {
  return {
    images: Object.fromEntries(
      Object.entries(images).map(([component, image]) => [
        component,
        {
          repository: image.repository,
          digest: image.digest,
        },
      ]),
    ),
    workflowSchema: {
      compatibility,
      migrationJob: { enabled: migrationJobEnabled },
    },
    release: {
      production: {
        enabled: true,
        sourceSha: manifest.source.sha,
        verification: {
          workflow: manifest.evidence.promotion.workflow,
          runId: manifest.evidence.promotion.runId,
          runAttempt: manifest.evidence.promotion.runAttempt,
        },
        chart,
        database: {
          managedWorkflowSchemaVersion: compatibility.maximumVersion,
        },
      },
    },
  };
}

export function createProductionHelmValues(manifest) {
  const release = assertStudioServerReleaseManifest(manifest, { requirePromoted: true });
  const schema = release.database.managedWorkflowSchema;
  return releaseValuesFor({
    manifest: release,
    chart: release.chart,
    images: release.images,
    // A normal release must verify exactly the candidate schema. The declared
    // rollback floor is consumed only by createForwardRollbackHelmValues(),
    // where the previous image verifies the already-migrated schema.
    compatibility: {
      minimumVersion: schema.version,
      maximumVersion: schema.version,
    },
    migrationJobEnabled: true,
  });
}

/**
 * Helm history cannot reverse a database migration. This constructs a forward
 * rollback: it restores the previous image set, disables the migration Job,
 * and preserves the candidate schema as the serving verifier's upper bound.
 */
export function createForwardRollbackHelmValues({ failedRelease, rollbackRelease }) {
  const failed = assertStudioServerReleaseManifest(failedRelease);
  const rollback = assertStudioServerReleaseManifest(rollbackRelease, { requirePromoted: true });
  const activeSchema = failed.database.managedWorkflowSchema;
  const rollbackSchema = rollback.database.managedWorkflowSchema;
  if (activeSchema.version < rollbackSchema.version) {
    throw new Error(
      '[studio-server-release-manifest] Cannot roll forward to a release whose schema is newer than the active schema',
    );
  }
  if (activeSchema.minimumRollbackCompatibleVersion > rollbackSchema.version) {
    throw new Error(
      `[studio-server-release-manifest] Release schema ${activeSchema.version} is not declared compatible with rollback release schema ${rollbackSchema.version}; do not use Helm rollback. Repair forward with a compatible image instead.`,
    );
  }
  return releaseValuesFor({
    manifest: rollback,
    // A forward rollback runs the current chart with the previous image set.
    // Keep its rendered-chart identity rather than incorrectly claiming that
    // the older image manifest's chart rendered these resources.
    chart: failed.chart,
    images: rollback.images,
    compatibility: {
      minimumVersion: rollbackSchema.minimumRollbackCompatibleVersion,
      maximumVersion: activeSchema.version,
    },
    migrationJobEnabled: false,
  });
}
