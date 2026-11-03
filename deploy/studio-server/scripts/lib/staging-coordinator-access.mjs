import assert from 'node:assert/strict';

function coordinatorRole(namespace, rules) {
  assert.match(namespace, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'rivet-release-ci', namespace },
    rules,
  };
}

/** Administrator-applied Roles. Hosted preparation never installs its own grants. */
export function stagingCoordinatorControlRole(namespace) {
  return coordinatorRole(namespace, [
    { apiGroups: [''], resources: ['pods'], verbs: ['get'] },
    { apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'create', 'update', 'patch'] },
    { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'watch', 'create', 'update', 'patch'] },
  ]);
}

export function stagingCoordinatorRunnerRole(namespace) {
  return coordinatorRole(namespace, [
    { apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'list', 'watch', 'create', 'delete'] },
    { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
  ]);
}

/** Check as the current CI caller, before the lock or shared worker is changed. */
export function assertStagingSetupAccess(settings, kubeconfig, run) {
  const control = settings.controlNamespace,
    runner = settings.runnerNamespace;
  for (const [verb, resource, namespace, subresource] of [
    ['get', 'pods', control],
    ['get', 'configmaps', control],
    ['list', 'configmaps', control],
    ['create', 'configmaps', control],
    ['patch', 'configmaps', control],
    ['get', 'deployments.apps', control],
    ['list', 'deployments.apps', control],
    ['patch', 'deployments.apps', control],
    ['watch', 'deployments.apps', control],
    ['get', 'jobs.batch', runner],
    ['create', 'jobs.batch', runner],
    ['delete', 'jobs.batch', runner],
    ['get', 'pods', runner],
    ['list', 'pods', runner],
    ['get', 'pods', runner, 'exec'],
    ['create', 'pods', runner, 'exec'],
  ]) {
    const answer = run('kubectl', [
      '--kubeconfig',
      kubeconfig,
      '--context',
      settings.context,
      'auth',
      'can-i',
      verb,
      resource,
      ...(subresource ? [`--subresource=${subresource}`] : []),
      '--namespace',
      namespace,
      '--request-timeout=15s',
    ]);
    assert.equal(
      answer.trim(),
      'yes',
      `Permission denied for ${verb} ${resource}${subresource ? `/${subresource}` : ''} in ${namespace}`,
    );
  }
}
