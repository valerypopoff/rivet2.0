import { createDeploymentSafety } from '../lib/deployment-safety.mjs';

/** Explicit local fixture admission. Production CLI tests use real policy and
 * backup adapters instead; this never manufactures production evidence. */
export function fixtureDeploymentSafety(
  mode,
  identity,
  { baseline = async () => {}, checkpoint = async () => {} } = {},
) {
  return createDeploymentSafety({
    mode,
    scope: 'local',
    checkBaseline: baseline,
    captureRecovery: checkpoint,
    localIdentity: {
      release: identity.release,
      namespace: identity.namespace,
      context: 'local-fixture',
      namespaceUid: 'local-fixture-namespace',
      candidateManifestDigest: identity.manifestDigest,
      workflowIdentity: identity.workflowIdentity,
    },
  });
}
