import assert from 'node:assert/strict';

export async function stagingAccessToken(fetchImpl = fetch) {
  const response = await fetchImpl(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    },
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(typeof value.access_token === 'string' && value.access_token);
  return value.access_token;
}

export function stagingCloudReader(settings, { fetchImpl = fetch, token } = {}) {
  const credentials = token ?? (() => stagingAccessToken(fetchImpl));
  const read = async (resource) => {
    assert.ok(
      [settings.projectId, settings.projectNumber].includes(resource.split('/')[1]),
      'Foreign provider resource rejected',
    );
    const response = await fetchImpl(`https://compute.googleapis.com/compute/v1/${resource}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${await credentials()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return null;
    assert.equal(response.status, 200, 'Provider absence is not established by an error');
    return response.json();
  };
  return {
    async project() {
      const response = await fetchImpl(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${settings.projectId}`,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${await credentials()}` },
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      );
      assert.equal(response.status, 200);
      const object = await response.json();
      assert.equal(object.projectId, settings.projectId);
      assert.equal(String(object.projectNumber), settings.projectNumber);
      assert.equal(object.lifecycleState, 'ACTIVE');
      return { projectId: object.projectId, projectNumber: String(object.projectNumber) };
    },
    async get(resource) {
      assert.match(
        resource,
        /^projects\/[a-z0-9-]+\/(?:(?:zones|regions)\/[a-z0-9-]+|global)\/(?:disks|networkEndpointGroups|backendServices|healthChecks)\/[a-z0-9-]+$/,
      );
      const object = await read(resource);
      if (!object) return null;
      assert.match(String(object.id), /^[1-9][0-9]*$/);
      assert.ok(object.selfLink?.endsWith(`/compute/v1/${resource}`));
      return object;
    },
    async children(inventory, { requiredNegIds } = {}) {
      const negs = inventory.filter((i) => i.kind === 'neg'),
        children = [];
      const required = new Set(requiredNegIds ?? negs.map((i) => i.id));
      if (!negs.length) return children;
      const data = await read(`projects/${settings.projectId}/aggregated/backendServices`);
      const complete = (scope) =>
        scope &&
        typeof scope === 'object' &&
        !Array.isArray(scope) &&
        (!scope.warning || scope.warning.code === 'NO_RESULTS_ON_PAGE');
      assert.ok(
        data &&
          !data.nextPageToken &&
          Array.isArray(data.unreachables ?? []) &&
          !data.unreachables?.length &&
          complete(data) &&
          ((data.items && typeof data.items === 'object' && !Array.isArray(data.items)) ||
            data.warning?.code === 'NO_RESULTS_ON_PAGE'),
        'Incomplete Gateway-child inventory requires inspection',
      );
      const resourceOf = (ref) => {
        assert.ok(
          ref?.startsWith('https://www.googleapis.com/compute/v1/') ||
            ref?.startsWith('https://compute.googleapis.com/compute/v1/'),
        );
        return ref.split('/compute/v1/')[1];
      };
      for (const scope of Object.values(data.items ?? {})) {
        assert.ok(
          complete(scope) && Array.isArray(scope.backendServices ?? []),
          'Incomplete Gateway-child scope requires inspection',
        );
        for (const backend of scope.backendServices ?? []) {
          if (!(backend.backends ?? []).some((b) => negs.some((n) => b.group?.endsWith(`/compute/v1/${n.resource}`))))
            continue;
          assert.ok(backend.healthChecks?.length, 'Gateway health-check creation is uncertain');
          const resource = resourceOf(backend.selfLink),
            value = await this.get(resource);
          assert.ok(value, 'Gateway backend changed during inventory');
          assert.match(String(backend.id), /^[1-9][0-9]*$/);
          assert.equal(String(value.id), String(backend.id), 'Gateway backend was replaced during inventory');
          // A name is not ownership. Pin both its immutable identity and the
          // relationships that made it an operation child before recording it.
          const groups = (b) => (b.backends ?? []).map((v) => resourceOf(v.group)).sort();
          const checks = (b) => (b.healthChecks ?? []).map(resourceOf).sort();
          assert.deepEqual(groups(value), groups(backend), 'Gateway backend groups changed during inventory');
          assert.deepEqual(checks(value), checks(backend), 'Gateway health checks changed during inventory');
          children.push({ resource, value });
          for (const resource of checks(value)) {
            const value = await this.get(resource);
            assert.ok(value?.id);
            children.push({ resource, value });
          }
        }
      }
      for (const neg of negs.filter((i) => required.has(i.id)))
        assert.ok(
          children.some((c) => c.value.backends?.some((b) => b.group?.endsWith(`/compute/v1/${neg.resource}`))),
          'Gateway backend creation is uncertain; retain the namespace',
        );
      return children;
    },
  };
}
