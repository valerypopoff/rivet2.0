import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { ManagedReleaseGate, runManagedGateCommand as run } from './kubernetes-managed-release-gate.mjs';
import { runHaReleaseRollout } from './kubernetes-ha-release-gate.mjs';
import { buildManagedProviderGateConfig } from './lib/kubernetes-managed-provider-gate-config.mjs';
import {
  assertStudioServerReleaseManifest,
  assertReleaseManifestMatchesCurrentChart,
  assertReleaseManifestMatchesCurrentSource,
} from './lib/studio-server-release-manifest.mjs';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { assertCandidateManifestImages } from './lib/kubernetes-candidate-manifest-images.mjs';
import { verifyHaReleaseRecovery } from './lib/ha-release-recovery-probes.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const chart = path.join(rootDir, 'deploy/studio-server/helm');

/** Provider observations are supplementary exact-pair evidence. They do not
 * replace or rewrite the production manifest's predecessor or certificate. */
export function assertProviderHaPair(baseline, candidate) {
  for (const value of [baseline, candidate]) {
    assertStudioServerReleaseManifest(value, { requirePromoted: true });
    assert.equal(value.evidence?.ha?.protocol, 3, 'provider HA needs browser-aware v3 images');
  }
  assert.equal(
    baseline.evidence.ha.browserContract.protocol,
    candidate.evidence.ha.browserContract.protocol,
    'provider HA cannot cross a browser-contract maintenance boundary',
  );
  assert.notEqual(baseline.source.sha, candidate.source.sha, 'provider HA requires distinct source versions');
  assert.equal(
    isDeepStrictEqual(baseline.images, candidate.images),
    false,
    'provider HA requires distinct immutable images',
  );
}

export class ProviderHaReleaseGate extends ManagedReleaseGate {
  constructor(config, kubectlBin, helmBin, { values, identity }) {
    super(config, kubectlBin, helmBin);
    assert.match(config.namespace, /^rivet-staging-[a-z0-9-]+$/);
    assert.match(identity?.namespaceUid ?? '', /^[a-f0-9-]{36}$/);
    assert.match(identity?.operation ?? '', /^[a-z0-9-]+$/);
    assert.equal(new URL(identity.clusterServer).protocol, 'https:');
    assert.ok(Number.isFinite(Date.parse(identity.expiresAt)), 'provider proof requires an explicit expiry');
    this.identity = identity;
    this.providerValues = values;
    this.config.proofValuesFiles = [config.valuesFile];
  }
  async assertProofContext() {
    assert.ok(Date.now() < Date.parse(this.identity.expiresAt), 'provider rehearsal has expired');
    await this.assertContext();
    const view = JSON.parse(
      (await this.kubectl(['config', 'view', '--minify', '-o', 'json'], { capture: true })).stdout,
    );
    assert.equal(view.clusters?.[0]?.cluster?.server, this.identity.clusterServer, 'provider cluster endpoint changed');
    const namespace = JSON.parse(
      (await this.kubectl(['get', 'namespace', this.config.namespace, '-o', 'json'], { capture: true })).stdout,
    );
    assert.equal(namespace.metadata.uid, this.identity.namespaceUid, 'provider namespace was replaced');
    assert.equal(
      namespace.metadata.labels?.['rivet.dev/ha-rehearsal'],
      this.identity.operation,
      'provider namespace is not owned by this rehearsal',
    );
  }
  values(images = this.config.images) {
    return {
      ...this.providerValues,
      fullnameOverride: this.config.release,
      images: Object.fromEntries(
        Object.entries(images).map(([key, image]) => [key, { ...image, pullPolicy: 'IfNotPresent' }]),
      ),
    };
  }
  async apply(values, name = 'provider-ha-values.json') {
    await this.assertProofContext();
    const file = path.join(this.config.artifactsDir, name);
    await fs.mkdir(this.config.artifactsDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(values));
    await run(this.helmBin, [
      '--kube-context',
      this.config.context,
      'upgrade',
      '--install',
      this.config.release,
      chart,
      '-n',
      this.config.namespace,
      '-f',
      this.config.valuesFile,
      '-f',
      file,
      '--wait',
      '--wait-for-jobs',
      '--timeout',
      `${this.config.deploymentTimeoutSeconds}s`,
    ]);
  }
  async loadWorkflowKey() {
    const auth = this.providerValues.auth;
    const secret = JSON.parse(
      (
        await this.kubectl(['-n', this.config.namespace, 'get', 'secret', auth.keySecretName, '-o', 'json'], {
          capture: true,
        })
      ).stdout,
    );
    this.secrets = { rivetKey: Buffer.from(secret.data[auth.keySecretKey ?? 'RIVET_KEY'], 'base64').toString('utf8') };
    const response = await fetch(new URL('/ui-auth', this.config.baseUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: this.secrets.rivetKey }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 204, 'provider must authenticate with its ordinary UI key gate');
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('rivet_ui_token='));
    assert.ok(cookie, 'provider login must issue a UI session');
    this.probeHeaders = { cookie: cookie.split(';')[0] };
    await response.body?.cancel();
  }
  requestWorkflow(baseUrl, route, options = {}) {
    assert.equal(
      new URL(baseUrl).origin,
      new URL(this.config.baseUrl).origin,
      'proof credentials must stay on the staging origin',
    );
    return super.requestWorkflow(baseUrl, route, {
      ...options,
      redirect: 'manual',
      headers: { ...options.headers, ...this.probeHeaders },
    });
  }
  async authenticateBrowser(context) {
    const response = await context.request.post(new URL('/ui-auth', this.config.baseUrl).href, {
      data: { key: this.secrets.rivetKey },
      maxRedirects: 0,
    });
    assert.equal(response.status(), 204, 'browser must use a real authenticated staging session');
  }
  async readProofSql(query) {
    assert.match(query, /^SELECT\s/i, 'proof database observations must be read-only');
    const source = `import pg from 'pg';const c=new pg.Client({connectionString:process.env.RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING,ssl:{rejectUnauthorized:false}});await c.connect();try{await c.query('BEGIN READ ONLY');const r=await c.query({text:process.argv[1],query_timeout:10000});console.log(JSON.stringify(Object.values(r.rows[0])[0]));}finally{await c.end();}`;
    const result = await this.kubectl(
      [
        '-n',
        this.config.namespace,
        'exec',
        `${this.config.release}-ha-backend-0`,
        '-c',
        'backend',
        '--',
        'node',
        '--input-type=module',
        '-e',
        source,
        query,
      ],
      { capture: true },
    );
    return JSON.parse(result.stdout.trim());
  }
  async seed() {
    await this.assertProofContext();
    await this.loadWorkflowKey();
    await fs.mkdir(this.config.artifactsDir, { recursive: true });
    await fs.writeFile(
      path.join(this.config.artifactsDir, 'ha-seed-started.json'),
      JSON.stringify({ at: new Date().toISOString(), namespaceUid: this.identity.namespaceUid }),
      { flag: 'wx' },
    );
    const contents = await fs.readFile(
      path.join(rootDir, 'deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project'),
      'utf8',
    );
    const request = (route, options) => this.requestWorkflow(this.config.baseUrl, route, options);
    const upload = await request('/api/workflows/projects/upload', {
      method: 'POST',
      body: JSON.stringify({
        folderRelativePath: '',
        fileName: 'managed-release-gate.rivet-project',
        contents,
      }),
    });
    const relativePath = upload.project.relativePath;
    const preconditions = async () => {
      const snapshot = await request(
        `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(relativePath)}`,
      );
      return {
        expectedProjectId: snapshot.projectId,
        expectedDraftRevisionId: snapshot.draftRevisionId,
        expectedPublicationVersion: snapshot.publicationVersion,
      };
    };
    await request('/api/workflows/projects/publish', {
      method: 'POST',
      body: JSON.stringify({
        relativePath,
        settings: { endpointName: 'managed-release-workflow' },
        preconditions: await preconditions(),
      }),
    });
    await request('/api/workflows/projects/web-apps/publish', {
      method: 'POST',
      body: JSON.stringify({
        relativePath,
        preconditions: await preconditions(),
        publications: [{ uiGraphId: 'release-gate-web-app', slug: 'release-gate-web-app' }],
      }),
    });
    await request('/workflows/managed-release-workflow', {
      method: 'POST',
      body: JSON.stringify({ input: 'provider-smoke' }),
    });
    await this.artifact('ha-persisted-state.json', JSON.stringify({ relativePath }));
  }
}

async function main() {
  // This runner never creates registry credentials. The operator's values own
  // imagePullSecrets; public images need no otherwise-unused registry token.
  const config = buildManagedProviderGateConfig({ rootDir, registryRequired: false });
  const raw = JSON.parse(await fs.readFile(config.configFile, 'utf8'));
  const baseline = assertStudioServerReleaseManifest(
    JSON.parse(await fs.readFile(process.env.RIVET_HA_PROVIDER_BASELINE_MANIFEST, 'utf8')),
    { requirePromoted: true },
  );
  const candidateFile = process.env.RIVET_HA_PROVIDER_CANDIDATE_MANIFEST;
  const candidate = candidateFile
    ? assertStudioServerReleaseManifest(JSON.parse(await fs.readFile(candidateFile, 'utf8')), { requirePromoted: true })
    : baseline;
  assertReleaseManifestMatchesCurrentChart(candidate, rootDir);
  for (const [component, image] of Object.entries(config.images))
    assert.deepEqual(image, candidate.images[component], 'provider configured images must match the pinned candidate');
  const phase = process.argv[2];
  assert.ok(['prepare', 'seed', 'roll'].includes(phase), 'choose prepare, seed or roll explicitly');
  if (phase === 'roll') {
    assertProviderHaPair(baseline, candidate);
    const sha = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).stdout.trim();
    assertReleaseManifestMatchesCurrentSource(candidate, sha);
    await run('git', ['diff', '--quiet', 'HEAD', '--']);
  }
  const gate = new ProviderHaReleaseGate(config, process.env.KUBECTL_BIN || 'kubectl', resolveHelmBinOrThrow(rootDir), {
    values: parse(await fs.readFile(config.valuesFile, 'utf8')),
    identity: raw.haProof,
  });
  try {
    await gate.assertProofContext();
    if (phase === 'prepare') {
      const existing = (
        await gate.kubectl(
          [
            '-n',
            config.namespace,
            'get',
            'statefulsets',
            '-l',
            `app.kubernetes.io/instance=${config.release}`,
            '-o',
            'json',
          ],
          { capture: true },
        )
      ).stdout;
      assert.equal(JSON.parse(existing).items.length, 0, 'provider preparation refuses an existing installation');
      await gate.apply(gate.values(baseline.images), 'provider-baseline-values.json');
    } else if (phase === 'seed') {
      await gate.seed();
    } else {
      const installed = await run(
        gate.helmBin,
        ['--kube-context', config.context, 'get', 'manifest', config.release, '-n', config.namespace],
        { capture: true },
      );
      assertCandidateManifestImages(
        installed.stdout,
        Object.fromEntries(Object.keys(config.images).map((component) => [component, baseline.images[component]])),
        'provider HA baseline',
      );
      const report = await runHaReleaseRollout(
        gate,
        config.baseUrl,
        candidate.images,
        baseline.evidence.ha.browserContract,
      );
      report.recovery = await verifyHaReleaseRecovery(gate, config.baseUrl, rootDir);
      await gate.artifact('provider-ha-report.json', JSON.stringify({ baseline, candidate, report }, null, 2));
    }
  } catch (error) {
    await gate.capture('provider-ha-failure').catch(() => {});
    throw error;
  } finally {
    await gate.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
