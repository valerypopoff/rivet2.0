import { buildKubernetesLauncherConfig, renderKubernetesLauncherValuesYaml } from './kubernetes-launcher-config.mjs';
import { prepareLocalServices } from './local-kubernetes-services.mjs';
import { renderKubernetesLauncherSecretManifest } from './kubernetes-launcher-config.mjs';

export function singleMachineConfig(env, { release, namespace, context }) {
  if (!context || env.RIVET_K8S_CONTEXT !== context) {
    throw new Error('Single-machine installation requires --context matching RIVET_K8S_CONTEXT in the selected .env.');
  }
  if (env.RIVET_K8S_RELEASE !== release || env.RIVET_K8S_NAMESPACE !== namespace) {
    throw new Error('Single-machine release and namespace must exactly match the selected .env.');
  }
  if (env.RIVET_K8S_LOCAL_MANAGED_SERVICES !== 'true') {
    throw new Error(
      'Single-machine installation requires RIVET_K8S_LOCAL_MANAGED_SERVICES=true. Use the ordinary cluster release command for external stores.',
    );
  }
  const config = buildKubernetesLauncherConfig(env, { singleMachine: true });
  for (const value of [config.sharedKey, config.localServices.password, config.objectStorage.secretAccessKey]) {
    if (value.startsWith('replace-with-'))
      throw new Error('Replace the example credentials before installing Rivet Server.');
  }
  if (!['k3s', 'minikube', 'docker-desktop'].includes(config.localClusterProvider)) {
    throw new Error('Single-machine installation requires an explicit supported local cluster provider.');
  }
  return config;
}

/** A local context name is not proof of a local cluster. Check the actual API and node inventory. */
export async function assertSingleMachineCluster(config, run) {
  const kubeconfig = JSON.parse((await run(['config', 'view', '--minify', '-o', 'json'], { capture: true })).stdout);
  const server = new URL(kubeconfig.clusters?.[0]?.cluster?.server ?? '');
  if (
    server.protocol !== 'https:' ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname)
  ) {
    throw new Error('Single-machine provisioning requires a loopback HTTPS Kubernetes API without URL credentials.');
  }
  const nodes = JSON.parse((await run(['get', 'nodes', '-o', 'json'], { capture: true })).stdout).items;
  if (
    !Array.isArray(nodes) ||
    nodes.length !== 1 ||
    !nodes[0].status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
  ) {
    throw new Error('Single-machine provisioning requires exactly one Ready Kubernetes node.');
  }
  if (config.localClusterProvider === 'k3s' && !/\+k3s/.test(nodes[0].status?.nodeInfo?.kubeletVersion ?? '')) {
    throw new Error('The selected single-machine cluster is not K3s.');
  }
}

export async function prepareSingleMachine(config, run) {
  await assertSingleMachineCluster(config, run);
  await prepareLocalServices(config, run, async () => {
    // Never put connection strings, credentials or key material in argv or Helm values.
    await run(['apply', '-f', '-'], { input: renderKubernetesLauncherSecretManifest(config), capture: true });
  });
}

export function singleMachineValues(config) {
  return renderKubernetesLauncherValuesYaml(config);
}
