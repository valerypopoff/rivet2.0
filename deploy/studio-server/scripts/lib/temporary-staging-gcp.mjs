import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectLifecyclePermissions = [
  'compute.networks.create',
  'compute.networks.delete',
  'compute.subnetworks.create',
  'compute.subnetworks.delete',
  'compute.firewalls.create',
  'compute.firewalls.delete',
  'compute.addresses.create',
  'compute.addresses.delete',
  'compute.routes.delete',
  'container.clusters.create',
  'container.clusters.delete',
  'compute.forwardingRules.delete',
  'compute.regionTargetHttpsProxies.delete',
  'compute.regionTargetHttpProxies.delete',
  'compute.regionUrlMaps.delete',
  'compute.regionBackendServices.delete',
  'compute.regionHealthChecks.delete',
  'compute.regionSslCertificates.delete',
  'compute.targetHttpsProxies.delete',
  'compute.targetHttpProxies.delete',
  'compute.urlMaps.delete',
  'compute.backendServices.delete',
  'compute.healthChecks.delete',
  'compute.sslCertificates.delete',
];
const defaults = {
  compute: 'https://compute.googleapis.com/compute/v1/',
  container: 'https://container.googleapis.com/v1/',
  crm: 'https://cloudresourcemanager.googleapis.com/v1/',
  iam: 'https://iam.googleapis.com/v1/',
  dns: 'https://dns.googleapis.com/dns/v1/',
};
export function assertTemporaryClusterNodeIdentity(plan, cluster) {
  assert.equal(cluster.autopilot?.enabled, true, 'Staging cluster is not Autopilot');
  const defaults = cluster.autoscaling?.autoprovisioningNodePoolDefaults;
  assert.equal(
    defaults?.serviceAccount,
    plan.nodeServiceAccount,
    'Autopilot node defaults do not use the approved staging service account',
  );
  assert.ok(
    Array.isArray(defaults.oauthScopes) &&
      defaults.oauthScopes.includes('https://www.googleapis.com/auth/cloud-platform'),
    'Autopilot node defaults lack the approved cloud-platform scope',
  );
  assert.ok(
    cluster.nodePools === undefined || Array.isArray(cluster.nodePools),
    'Unexpected Autopilot node-pool inventory',
  );
  for (const pool of cluster.nodePools ?? []) {
    assert.equal(
      pool.config?.serviceAccount,
      plan.nodeServiceAccount,
      'Autopilot node pool does not use the approved staging service account',
    );
    assert.ok(
      Array.isArray(pool.config.oauthScopes) &&
        pool.config.oauthScopes.includes('https://www.googleapis.com/auth/cloud-platform'),
      'Autopilot node pool lacks the approved cloud-platform scope',
    );
  }
}
export class TemporaryCloudError extends Error {
  constructor(status) {
    super(`Staging cloud request failed (${status}); inspect the journal before another write`);
    this.status = status;
  }
}
export function cachedTemporaryToken(mint, { now = Date.now } = {}) {
  let current, pending;
  return async () => {
    const time = now();
    if (current && time >= current.issuedAt && time < current.refreshAt) return current.token;
    if (!pending)
      pending = (async () => {
        const issuedAt = now(),
          value = await mint(),
          { token, expiresAt } = value;
        assert.ok(typeof token === 'string' && token && !/\s/.test(token));
        assert.ok(Number.isFinite(expiresAt) && expiresAt > now() + 300000, 'Credential expiry is missing or too near');
        assert.ok(now() - issuedAt < 60000, 'Credential minting exceeded its bounded validity margin');
        current = { token, issuedAt, refreshAt: Math.min(issuedAt + 3000000, expiresAt - 300000) };
        return token;
      })().finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
export async function mintTemporaryToken(plan, { sourceToken, fetchImpl = fetch } = {}) {
  assert.equal(plan.operatorServiceAccount.split('@')[1], `${plan.projectId}.iam.gserviceaccount.com`);
  const source = sourceToken
    ? await sourceToken()
    : (
        await exec(process.env.RIVET_GCLOUD_BIN || 'gcloud', ['auth', 'print-access-token'], {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 65536,
          env: { ...process.env, CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '' },
        })
      ).stdout.trim();
  assert.ok(source && !/\s/.test(source));
  const response = await fetchImpl(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${plan.operatorServiceAccount}:generateAccessToken`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${source}`,
        'content-type': 'application/json',
        'x-goog-user-project': plan.projectId,
      },
      body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '3600s' }),
    },
  );
  assert.equal(response.status, 200, 'Staging operator token minting failed');
  const chunks = [];
  let size = 0;
  for await (const c of response.body) {
    assert.ok((size += c.length) < 65536);
    chunks.push(c);
  }
  const value = JSON.parse(Buffer.concat(chunks));
  return { token: value.accessToken, expiresAt: Date.parse(value.expireTime) };
}
export function temporaryGcp(plan, { origins = defaults, simulation = false, token, timeoutMs = 15000 } = {}) {
  for (const [name, url] of Object.entries(origins)) {
    assert.ok(defaults[name]);
    const parsed = new URL(url);
    if (simulation) assert.ok(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1');
    else assert.equal(url, defaults[name]);
  }
  assert.equal(Object.keys(origins).length, Object.keys(defaults).length);
  const credentials =
    token ??
    cachedTemporaryToken(async () => {
      assert.equal(simulation, false);
      return mintTemporaryToken(plan);
    });
  async function request(service, method, resource, body) {
    assert.ok(
      resource.startsWith(`projects/${plan.projectId}/`) ||
        resource === `projects/${plan.projectId}` ||
        (service === 'crm' && method === 'POST' && resource === `projects/${plan.projectId}:testIamPermissions`) ||
        (service === 'iam' &&
          resource.startsWith(`projects/-/serviceAccounts/`) &&
          resource.includes(`@${plan.projectId}.iam.gserviceaccount.com`)),
    );
    assert.ok(!resource.includes('..') && !resource.includes('://'));
    const response = await fetch(new URL(resource, origins[service]), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${await credentials()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new TemporaryCloudError(response.status);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      assert.ok((size += chunk.length) < 4 * 1024 * 1024);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw Error('Staging cloud returned invalid JSON; acknowledgement is uncertain');
    }
  }
  const readerPolicy = async (expectedAccountId) => {
    const base = `projects/-/serviceAccounts/${plan.janitorServiceAccount}`;
    const account = await request('iam', 'GET', base);
    assert.equal(account?.uniqueId, expectedAccountId, 'Staging reader account identity changed');
    const policy = await request('iam', 'POST', `${base}:getIamPolicy?options.requestedPolicyVersion=3`);
    assert.ok(policy?.etag, 'Staging reader policy must include its current etag');
    return { base, policy };
  };
  return {
    request,
    simulation,
    credentials,
    async snapshot() {
      const result = [];
      const list = async (service, resource, kind, aggregated = false) => {
        let token;
        const seen = new Set();
        do {
          const data = await request(
            service,
            'GET',
            resource + (token ? `?pageToken=${encodeURIComponent(token)}` : ''),
          );
          assert.ok(data && !data.unreachables?.length && !data.missingZones?.length);
          const scopes = aggregated ? Object.values(data.items ?? {}) : [data];
          for (const scope of scopes) {
            assert.ok(!scope.warning || scope.warning.code === 'NO_RESULTS_ON_PAGE');
            for (const item of scope[kind] ?? scope.items ?? []) {
              assert.ok(item.id && item.name);
              result.push({
                kind,
                id: String(item.id),
                name: item.name,
                resource: item.selfLink?.split('/compute/v1/')[1] ?? item.name,
                ...(item.network ? { network: item.network } : {}),
              });
            }
          }
          token = data.nextPageToken;
          if (token) {
            assert.ok(!seen.has(token) && seen.size < 100);
            seen.add(token);
          }
        } while (token);
      };
      for (const kind of [
        'networks',
        'firewalls',
        'routes',
        'instanceTemplates',
        'addresses',
        'forwardingRules',
        'targetHttpProxies',
        'targetHttpsProxies',
        'urlMaps',
        'sslCertificates',
        'sslPolicies',
        'healthChecks',
        'backendServices',
      ])
        await list('compute', `projects/${plan.projectId}/global/${kind}`, kind);
      for (const kind of [
        'subnetworks',
        'addresses',
        'disks',
        'networkEndpointGroups',
        'instances',
        'instanceTemplates',
        'instanceGroups',
        'instanceGroupManagers',
        'routers',
        'forwardingRules',
        'targetHttpProxies',
        'targetHttpsProxies',
        'urlMaps',
        'sslCertificates',
        'healthChecks',
        'backendServices',
      ])
        await list('compute', `projects/${plan.projectId}/aggregated/${kind}`, kind, true);
      const data = await request('container', 'GET', `projects/${plan.projectId}/locations/-/clusters`);
      assert.ok(data && !data.missingZones?.length && !data.nextPageToken);
      for (const c of data.clusters ?? []) {
        assert.ok(c.id);
        result.push({ kind: 'clusters', id: String(c.id), name: c.name, resource: c.selfLink });
      }
      return result.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    },
    async edgeChildren(ip) {
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
      const data = await request('compute', 'GET', `projects/${plan.projectId}/regions/${plan.region}/forwardingRules`);
      assert.ok(data && !data.nextPageToken);
      const items = [],
        seen = new Set();
      const visit = async (ref) => {
        assert.match(ref, /^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//);
        const resource = ref.split('/compute/v1/')[1];
        assert.ok(resource.startsWith(`projects/${plan.projectId}/`));
        assert.match(
          resource,
          new RegExp(
            `^projects/${plan.projectId}/(?:global|regions/${plan.region})/(?:forwardingRules|targetHttpsProxies|targetHttpProxies|urlMaps|sslCertificates|backendServices|healthChecks)/[a-z0-9-]+$`,
          ),
        );
        if (seen.has(resource)) return;
        seen.add(resource);
        const value = await request('compute', 'GET', resource);
        assert.ok(value?.id);
        items.push({ resource, id: String(value.id) });
        for (const link of [
          value.target,
          value.urlMap,
          value.defaultService,
          ...(value.sslCertificates ?? []),
          ...(value.healthChecks ?? []),
          ...(value.pathMatchers ?? []).flatMap((m) => [
            m.defaultService,
            ...(m.pathRules ?? []).map((r) => r.service),
          ]),
        ].filter(Boolean))
          await visit(link);
      };
      for (const rule of data.items ?? []) if (rule.IPAddress === ip) await visit(rule.selfLink);
      return items;
    },
    async project() {
      const p = await request('crm', 'GET', `projects/${plan.projectId}`);
      assert.equal(p?.projectId, plan.projectId);
      assert.equal(String(p.projectNumber), plan.projectNumber);
      assert.equal(p.lifecycleState, 'ACTIVE');
    },
    async preflight() {
      await this.project();
      const access = await request('crm', 'POST', `projects/${plan.projectId}:testIamPermissions`, {
        permissions: projectLifecyclePermissions,
      });
      const missing = projectLifecyclePermissions.filter((permission) => !access?.permissions?.includes(permission));
      assert.equal(missing.length, 0, `Staging lifecycle permissions are missing: ${missing.join(', ')}`);
      const [project, region, server] = await Promise.all([
        request('compute', 'GET', `projects/${plan.projectId}`),
        request('compute', 'GET', `projects/${plan.projectId}/regions/${plan.region}`),
        request('container', 'GET', `projects/${plan.projectId}/locations/${plan.region}/serverConfig`),
      ]);
      assert.ok(server.validMasterVersions.includes(plan.kubernetesVersion));
      const available = (items, name, required) => {
        const q = items.find((x) => x.metric === name);
        assert.ok(q && q.limit - q.usage >= required, `Staging ${name} quota is insufficient`);
      };
      available(project.quotas, 'NETWORKS', 1);
      available(project.quotas, 'CPUS_ALL_REGIONS', plan.estimate.cpus);
      available(region.quotas, 'SSD_TOTAL_GB', plan.estimate.ssdGb);
      available(region.quotas, 'IN_USE_ADDRESSES', plan.estimate.externalAddresses);
      if (!plan.hostnameMode) {
        const zone = await request('dns', 'GET', `projects/${plan.projectId}/managedZones/${plan.managedZone}`);
        assert.ok(
          typeof zone?.dnsName === 'string' &&
            (`${plan.domain}.` === zone.dnsName || `${plan.domain}.`.endsWith(`.${zone.dnsName}`)),
          'Staging hostname is outside the managed DNS zone',
        );
      }
      const accounts = [];
      for (const email of [plan.nodeServiceAccount, plan.janitorServiceAccount, plan.operatorServiceAccount]) {
        const account = await request('iam', 'GET', `projects/-/serviceAccounts/${email}`);
        assert.equal(account.email, email);
        assert.ok(account.uniqueId && !account.disabled);
        accounts.push({ email, id: account.uniqueId, preexisting: true });
      }
      await readerPolicy(accounts.find((account) => account.email === plan.janitorServiceAccount).id);
      return accounts;
    },
    async get(spec) {
      return request(spec.service, 'GET', spec.path);
    },
    identity(spec, value) {
      if (!value) return null;
      assert.equal(value.name, spec.name);
      assert.equal(value.description, spec.body.description);
      assert.ok(value.id, 'Cloud immutable identity is missing');
      if (spec.kind === 'cluster') assert.equal(value.resourceLabels?.['rivet-operation'], plan.inputHash.slice(0, 63));
      return {
        id: String(value.id),
        name: value.name,
        ...(spec.kind === 'cluster' ? { endpoint: value.endpoint, ca: value.masterAuth?.clusterCaCertificate } : {}),
      };
    },
    async create(spec) {
      return request(
        spec.service,
        'POST',
        spec.collection,
        spec.kind === 'cluster' ? { cluster: spec.body } : spec.body,
      );
    },
    async remove(spec) {
      return request(spec.service, 'DELETE', spec.path);
    },
    async wait(spec, operation, { wait, checkpoint = async () => {} }) {
      assert.ok(operation?.name);
      const base =
        spec.service === 'compute'
          ? spec.collection.replace(/\/(networks|subnetworks|addresses|firewalls|routes)$/, '/operations')
          : `projects/${plan.projectId}/locations/${plan.region}/operations`;
      const opName = operation.name.split('/').at(-1);
      assert.match(opName, /^[a-zA-Z0-9_-]+$/);
      const ref = `${base}/${opName}`;
      await wait('cloud operation completion', async () => {
        await checkpoint();
        const actual = await request(spec.service, 'GET', ref);
        assert.ok(actual, 'Accepted cloud operation disappeared');
        assert.equal(actual.name.split('/').at(-1), opName);
        if (operation.id) assert.equal(String(actual.id), String(operation.id));
        if (actual.targetLink) {
          const target = new URL(actual.targetLink);
          assert.ok(
            (spec.service === 'compute'
              ? ['https://compute.googleapis.com', 'https://www.googleapis.com']
              : ['https://container.googleapis.com']
            ).includes(target.origin),
          );
          const resource = target.pathname
            .replace(spec.service === 'compute' ? /^\/compute\/v1\// : /^\/v1\//, '')
            .replace(`projects/${plan.projectNumber}/`, `projects/${plan.projectId}/`);
          const canonical =
            spec.service === 'container'
              ? resource.replace(`/zones/${plan.region}/`, `/locations/${plan.region}/`)
              : resource;
          assert.equal(canonical, spec.path, 'Operation targets another resource');
        }
        if (actual.targetId && operation.targetId) assert.equal(actual.targetId, operation.targetId);
        if (actual.status !== 'DONE') return false;
        assert.ok(!actual.error && !actual.httpErrorStatusCode, 'Cloud operation failed');
        return true;
      });
    },
    async dnsRecord(value, remove = false) {
      const root = `projects/${plan.projectId}/managedZones/${plan.managedZone}`;
      const response = await request('dns', 'GET', `${root}/rrsets?name=${encodeURIComponent(value.name)}&type=A`);
      assert.ok(Array.isArray(response?.rrsets) && !response.nextPageToken);
      if (!remove) assert.equal(response.rrsets.length, 0, 'Staging DNS name is already occupied');
      else {
        assert.deepEqual(response.rrsets, [value]);
      }
      return request('dns', 'POST', `${root}/changes`, { [remove ? 'deletions' : 'additions']: [value] });
    },
    async readDns(name) {
      const data = await request(
        'dns',
        'GET',
        `projects/${plan.projectId}/managedZones/${plan.managedZone}/rrsets?name=${encodeURIComponent(name)}&type=A`,
      );
      assert.ok(Array.isArray(data?.rrsets) && !data.nextPageToken);
      return data.rrsets;
    },
    async readBinding(member, expectedAccountId) {
      const { policy } = await readerPolicy(expectedAccountId);
      return !!policy.bindings?.some(
        (b) => b.role === 'roles/iam.workloadIdentityUser' && !b.condition && b.members?.includes(member),
      );
    },
    async iamBinding(member, remove, expectedAccountId) {
      const { base, policy } = await readerPolicy(expectedAccountId);
      const role = 'roles/iam.workloadIdentityUser',
        before = policy.bindings?.find((b) => b.role === role && !b.condition);
      const exists = !!before?.members?.includes(member);
      if (exists === !remove) return { preexisting: exists, observed: true };
      const next = structuredClone(policy);
      next.bindings ??= [];
      const binding = next.bindings.find((b) => b.role === role && !b.condition) ?? { role, members: [] };
      if (remove) binding.members = binding.members.filter((m) => m !== member);
      else binding.members.push(member);
      if (!next.bindings.includes(binding)) next.bindings.push(binding);
      next.bindings = next.bindings.filter((b) => b !== binding || b.members.length);
      await request('iam', 'POST', `${base}:setIamPolicy`, { policy: next });
      return { preexisting: exists, observed: true };
    },
  };
}
export function temporaryFoundationSpecs(plan) {
  const root = `projects/${plan.projectId}`,
    region = `${root}/regions/${plan.region}`,
    name = plan.operationId;
  const owner = `Rivet temporary qualification ${plan.inputHash}`;
  const network = `${root}/global/networks/${name}`,
    subnet = `${region}/subnetworks/${name}-nodes`;
  const spec = (key, kind, service, collection, body, billable = false) => ({
    key,
    kind,
    service,
    collection,
    path: `${collection}/${body.name}`,
    name: body.name,
    body,
    billable,
  });
  return [
    spec('network', 'network', 'compute', `${root}/global/networks`, {
      name,
      description: owner,
      autoCreateSubnetworks: false,
    }),
    spec('nodes', 'subnetwork', 'compute', `${region}/subnetworks`, {
      name: `${name}-nodes`,
      description: owner,
      network,
      ipCidrRange: plan.cidrs.nodes,
      privateIpGoogleAccess: true,
      secondaryIpRanges: [
        { rangeName: 'pods', ipCidrRange: plan.cidrs.pods },
        { rangeName: 'services', ipCidrRange: plan.cidrs.services },
      ],
    }),
    spec('proxy', 'subnetwork', 'compute', `${region}/subnetworks`, {
      name: `${name}-proxy`,
      description: owner,
      network,
      ipCidrRange: plan.cidrs.proxy,
      purpose: 'REGIONAL_MANAGED_PROXY',
      role: 'ACTIVE',
    }),
    spec('edge-firewall', 'firewall', 'compute', `${root}/global/firewalls`, {
      name: `${name}-edge`,
      description: owner,
      network,
      direction: 'INGRESS',
      priority: 1000,
      sourceRanges: [plan.cidrs.proxy, '35.191.0.0/16', '130.211.0.0/22'],
      targetServiceAccounts: [plan.nodeServiceAccount],
      allowed: [{ IPProtocol: 'tcp', ports: ['8080', '8081', '80'] }],
    }),
    spec(
      'address',
      'address',
      'compute',
      `${region}/addresses`,
      { name: `${name}-edge`, description: owner, addressType: 'EXTERNAL', networkTier: 'PREMIUM' },
      true,
    ),
    spec(
      'cluster',
      'cluster',
      'container',
      `${root}/locations/${plan.region}/clusters`,
      {
        name,
        description: owner,
        initialClusterVersion: plan.kubernetesVersion,
        autopilot: { enabled: true },
        privateClusterConfig: { enablePrivateNodes: false, enablePrivateEndpoint: false },
        network,
        subnetwork: subnet,
        autoscaling: {
          autoprovisioningNodePoolDefaults: {
            serviceAccount: plan.nodeServiceAccount,
            oauthScopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
        },
        resourceLabels: { 'rivet-operation': plan.inputHash.slice(0, 63) },
        releaseChannel: { channel: 'REGULAR' },
        ipAllocationPolicy: {
          useIpAliases: true,
          clusterSecondaryRangeName: 'pods',
          servicesSecondaryRangeName: 'services',
        },
        networkConfig: { gatewayApiConfig: { channel: 'CHANNEL_STANDARD' } },
        addonsConfig: { httpLoadBalancing: { disabled: false } },
        workloadIdentityConfig: { workloadPool: `${plan.projectId}.svc.id.goog` },
        masterAuthorizedNetworksConfig: {
          enabled: true,
          cidrBlocks: plan.trustedClients.map((cidrBlock) => ({ cidrBlock, displayName: 'qualification-control' })),
        },
      },
      true,
    ),
  ];
}
