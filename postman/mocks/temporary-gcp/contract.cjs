// Local contract stand-in, derived from Google Compute v1, GKE v1, CRM v1,
// Cloud DNS v1 and IAM v1 REST references. No real credentials or cloud access.
exports.handler = () => {
  let plan,
    resources = new Map(),
    operations = new Map(),
    requests = [],
    fault = null,
    seq = 100;
  return async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    try {
      const chunks = [];
      if (typeof req[Symbol.asyncIterator] === 'function') for await (const chunk of req) chunks.push(chunk);
      const body =
        req.body !== undefined
          ? typeof req.body === 'string'
            ? JSON.parse(req.body)
            : req.body
          : chunks.length
            ? JSON.parse(Buffer.concat(chunks))
            : undefined;
      const url = new URL(req.url, 'http://local'),
        parts = url.pathname.split('/').filter(Boolean),
        service = parts.shift(),
        resource = parts.join('/');
      if (url.pathname === '/_control' && req.method === 'POST') {
        plan = body.plan;
        resources = new Map();
        operations = new Map();
        requests = [];
        fault = body.fault ?? null;
        seq = 100;
        return respond(200, { reset: true });
      }
      if (url.pathname === '/_requests') return respond(200, requests);
      if (url.pathname === '/_replace' && req.method === 'POST') {
        resources.set(body.resource, body.value);
        return respond(200, { changed: true });
      }
      requests.push({ service, method: req.method, resource });
      if (!plan) return respond(503, { error: 'Fixture not initialized' });
      if (req.headers.authorization !== 'Bearer local-only')
        return respond(401, { error: 'Local credential required' });
      const root = `projects/${plan.projectId}`;
      if (
        service === 'credentials' &&
        resource === `projects/-/serviceAccounts/${plan.operatorServiceAccount}:generateAccessToken` &&
        req.method === 'POST'
      ) {
        if (
          body.lifetime !== '3600s' ||
          JSON.stringify(body.scope) !== JSON.stringify(['https://www.googleapis.com/auth/cloud-platform'])
        )
          return respond(400, { error: 'Unexpected token scope' });
        return respond(200, { accessToken: 'local-only', expireTime: new Date(Date.now() + 3600000).toISOString() });
      }
      if (resource.includes('wartime-storyteller')) return respond(403, { error: 'Production excluded' });
      if (service === 'crm' && resource === root && req.method === 'GET')
        return respond(200, { projectId: plan.projectId, projectNumber: plan.projectNumber, lifecycleState: 'ACTIVE' });
      if (service === 'compute' && resource === root)
        return respond(200, {
          quotas: [
            { metric: 'NETWORKS', usage: 0, limit: 7 },
            { metric: 'CPUS_ALL_REGIONS', usage: 0, limit: 1000 },
          ],
        });
      if (service === 'compute' && resource === `${root}/regions/${plan.region}`)
        return respond(200, {
          quotas: [
            { metric: 'SSD_TOTAL_GB', usage: 0, limit: 10000 },
            { metric: 'IN_USE_ADDRESSES', usage: 0, limit: 100 },
          ],
        });
      if (service === 'container' && resource.endsWith('/serverConfig'))
        return respond(200, { validMasterVersions: [plan.kubernetesVersion] });
      if (service === 'iam' && /^projects\/-\/serviceAccounts\/[^/:]+$/.test(resource))
        return respond(200, { email: resource.split('/').at(-1), uniqueId: '111111111111111111111' });
      if (service === 'dns' && resource === `${root}/managedZones/${plan.managedZone}`)
        return respond(200, { dnsName: `${plan.domain}.` });
      if (service === 'dns' && resource.endsWith('/rrsets'))
        return respond(200, { rrsets: resources.get('dns') ?? [] });
      if (service === 'dns' && resource.endsWith('/changes') && req.method === 'POST') {
        resources.set('dns', body.additions ?? []);
        return respond(200, { id: String(++seq), status: 'done' });
      }
      if (service === 'iam' && resource.endsWith(':getIamPolicy'))
        return respond(200, resources.get('policy') ?? { etag: 'local-etag', bindings: [] });
      if (service === 'iam' && resource.endsWith(':setIamPolicy') && req.method === 'POST') {
        resources.set('policy', body.policy);
        return respond(200, body.policy);
      }
      if (req.method === 'GET' && resource.includes('/operations/'))
        return operations.has(resource)
          ? respond(200, operations.get(resource))
          : respond(404, { error: 'Unknown operation' });
      const kind = resource.split('/').at(-1);
      const collections = [
        'networks',
        'subnetworks',
        'firewalls',
        'addresses',
        'routes',
        'clusters',
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
        'sslPolicies',
        'healthChecks',
        'backendServices',
      ];
      if (req.method === 'GET' && collections.includes(kind)) {
        const values = [...resources.entries()]
          .filter(([key]) => key.startsWith(`${root}/`) && key.split('/').at(-2) === kind)
          .map(([, value]) => value);
        if (resource.includes('/aggregated/'))
          return respond(200, { items: values.length ? { [`regions/${plan.region}`]: { [kind]: values } } : {} });
        return respond(200, kind === 'clusters' ? { clusters: values } : { items: values });
      }
      if (req.method === 'POST' && ['networks', 'subnetworks', 'firewalls', 'addresses', 'clusters'].includes(kind)) {
        if (fault?.type === 'html' && fault.kind === kind) {
          res.writeHead(500, { 'content-type': 'text/html' });
          return res.end('<html>upstream unavailable</html>');
        }
        const value = structuredClone(kind === 'clusters' ? body.cluster : body),
          key = `${resource}/${value.name}`;
        if (resources.has(key)) return respond(409, { error: 'Already exists' });
        Object.assign(value, { id: String(++seq), selfLink: `https://www.googleapis.com/compute/v1/${key}` });
        if (kind === 'addresses') value.address = '192.0.2.10';
        if (kind === 'clusters') {
          value.endpoint = '127.0.0.1';
          value.masterAuth = { clusterCaCertificate: Buffer.from('local fixture').toString('base64') };
        }
        resources.set(key, value);
        const name = `op-${++seq}`,
          base = resource.replace(/\/(networks|subnetworks|firewalls|addresses|clusters)$/, '/operations');
        const operation = {
          name,
          id: String(seq),
          status: 'DONE',
          ...(service === 'compute'
            ? { targetId: value.id, targetLink: value.selfLink }
            : { targetLink: `https://container.googleapis.com/v1/${key}` }),
        };
        operations.set(`${base}/${name}`, operation);
        if (fault?.type === 'lost-create' && fault.kind === kind) {
          fault = null;
          return typeof res.destroy === 'function' ? res.destroy() : respond(500, { error: 'Acknowledgement lost' });
        }
        if (fault?.type === 'hang' && fault.kind === kind) return; // Caller must time out; test destroys server sockets.
        return respond(200, operation);
      }
      if (req.method === 'GET' && collections.includes(resource.split('/').at(-2)))
        return resources.has(resource) ? respond(200, resources.get(resource)) : respond(404, { error: 'Not found' });
      if (req.method === 'DELETE' && resources.has(resource)) {
        const value = resources.get(resource);
        resources.delete(resource);
        if (resource.includes('/clusters/'))
          for (const [key, item] of resources) if (item.createdByClusterId === value.id) resources.delete(key);
        const name = `op-${++seq}`,
          base = resource
            .slice(0, resource.lastIndexOf('/'))
            .replace(/\/(networks|subnetworks|firewalls|routes|addresses|clusters)$/, '/operations');
        const operation = {
          name,
          id: String(seq),
          status: 'DONE',
          ...(service === 'compute'
            ? { targetId: value.id, targetLink: value.selfLink }
            : { targetLink: `https://container.googleapis.com/v1/${resource}` }),
        };
        operations.set(`${base}/${name}`, operation);
        if (fault?.type === 'lost-delete') {
          fault = null;
          return typeof res.destroy === 'function' ? res.destroy() : respond(500, { error: 'Acknowledgement lost' });
        }
        return respond(200, operation);
      }
      return respond(501, { error: 'Endpoint not modeled' });
    } catch {
      if (!res.headersSent) respond(500, { error: 'Invalid local fixture request' });
      else res.destroy();
    }
  };
};
