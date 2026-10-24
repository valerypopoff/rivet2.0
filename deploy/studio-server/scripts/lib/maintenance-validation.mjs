/** Temporary validation is fenced, but an existing HA installation must keep
 * its controller/storage identities. HA adoption retains the singleton bridge. */
export function createMaintenanceValidationValues(base, { sameLayout, haRequested }) {
  if (typeof sameLayout !== 'boolean' || typeof haRequested !== 'boolean' || (sameLayout && !haRequested))
    throw new Error('Maintenance validation layout must match the requested HA profile.');
  const values = structuredClone(base);
  values.workflowSchema = { ...values.workflowSchema, maintenanceValidation: true };
  values.replicaCount = { ...values.replicaCount, proxy: 0, web: 0, evaluation: 0 };
  values.autoscaling ??= {};
  for (const component of ['executionController', 'proxy', 'web', 'backend', 'execution'])
    values.autoscaling[component] = { ...values.autoscaling[component], enabled: false };
  if (sameLayout) {
    delete values.ha;
    delete values.availability;
  } else {
    values.ha = { enabled: false, controlPlane: { mode: 'replicated' } };
    // The compact profile requires HA; the fenced legacy bridge has no edge.
    values.availability = { ...values.availability, gkeGateway: false, gkeGatewayProfile: 'regional' };
    if (haRequested) values.replicaCount.backend = 1;
  }
  return values;
}

const apiContainers = new Set(['backend', 'api', 'execution']);
const apiPorts = new Set(['http', 'api', 'api-http', 'execution-http']);

function literalEnvironment(container, name) {
  const matches = (container.env ?? []).filter((entry) => entry.name === name);
  if (matches.length > 1 || matches.some((entry) => typeof entry.value !== 'string' || entry.valueFrom))
    throw new Error(`Maintenance validation container ${container.name} has ambiguous ${name}.`);
  return matches[0]?.value;
}

function validationPort(container) {
  if (literalEnvironment(container, 'RIVET_RELEASE_MAINTENANCE') !== 'true')
    throw new Error(`Maintenance validation container ${container.name} is not fenced.`);
  const ports = (container.ports ?? []).filter((port) => apiPorts.has(port.name));
  if (
    ports.length !== 1 ||
    !Number.isInteger(ports[0].containerPort) ||
    ports[0].containerPort < 1 ||
    ports[0].containerPort > 65535
  )
    throw new Error(`Maintenance validation container ${container.name} has no unambiguous API port.`);
  const port = ports[0].containerPort;
  for (const name of ['RIVET_BACKEND_API_PORT', 'PORT']) {
    const value = literalEnvironment(container, name);
    if (value !== undefined && (!/^\d+$/.test(value) || Number(value) !== port))
      throw new Error(`Maintenance validation container ${container.name} has a mismatched ${name}.`);
  }
  return port;
}

/** Call only after release settlement has verified owner chains and images.
 * Use the rendered topology, not assumptions about role/container names: a
 * clustered execution pod uses "api", while single-machine uses "execution". */
export function getMaintenanceValidationTargets(resources, pods) {
  const targets = [];
  const selectedPods = new Set();
  for (const owner of resources.filter((resource) => ['Deployment', 'StatefulSet'].includes(resource.kind))) {
    const containers = (owner.spec?.template?.spec?.containers ?? []).filter((container) =>
      apiContainers.has(container.name),
    );
    if (!containers.length) continue;
    const replicas = owner.spec.replicas ?? 1;
    const labels = owner.spec.selector?.matchLabels;
    if (
      !Number.isInteger(replicas) ||
      replicas < 0 ||
      !labels ||
      !Object.keys(labels).length ||
      owner.spec.selector.matchExpressions?.length
    )
      throw new Error(
        `Maintenance validation owner ${owner.metadata.name} has an unsupported selector or replica count.`,
      );
    const matchingPods = pods.filter((pod) =>
      Object.entries(labels).every(([key, value]) => pod.metadata?.labels?.[key] === value),
    );
    if (matchingPods.length !== replicas)
      throw new Error(`Maintenance validation owner ${owner.metadata.name} has not settled to ${replicas} pods.`);
    const expectedPorts = containers.map((container) => ({ container, port: validationPort(container) }));
    for (const pod of matchingPods.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))) {
      const podName = pod.metadata?.name;
      if (
        !podName ||
        selectedPods.has(podName) ||
        pod.metadata.deletionTimestamp ||
        pod.status?.phase !== 'Running' ||
        !pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')
      )
        throw new Error(`Maintenance validation pod ${podName ?? '(unnamed)'} is not uniquely ready.`);
      selectedPods.add(podName);
      for (const { container, port } of expectedPorts) {
        const actual = (pod.spec?.containers ?? []).filter((entry) => entry.name === container.name);
        if (actual.length !== 1 || actual[0].image !== container.image || validationPort(actual[0]) !== port)
          throw new Error(`Maintenance validation pod ${podName} does not match rendered container ${container.name}.`);
        targets.push({ podName, container: container.name, port });
      }
    }
  }
  if (!targets.length) throw new Error('Maintenance validation has no fenced API targets.');
  return targets;
}
