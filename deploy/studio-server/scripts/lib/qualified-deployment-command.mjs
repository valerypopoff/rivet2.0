import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This already-qualified revision omitted the Node assertion import in its
// production entry point. Its rollout libraries and source guards stay intact.
export const legacyAssertionSource = 'cf1bba99cbab4a0cf0afdcbfd2672ee95c090e70';

export function qualifiedDeploymentCommand({ sourceSha, root, program, args, node = process.execPath, preload }) {
  if (
    sourceSha === legacyAssertionSource &&
    program === node &&
    args[0] === path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs')
  )
    return ['--import', pathToFileURL(preload).href, ...args];
  return args;
}
