import fs from 'node:fs';
import path from 'node:path';

function isPathInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function isExternalRivetWorkspace(wrapperRootDir, rivetRootDir) {
  const realWrapperRootDir = fs.realpathSync(wrapperRootDir);
  const realRivetRootDir = fs.realpathSync(rivetRootDir);
  return !isPathInside(realWrapperRootDir, realRivetRootDir);
}

export function hasRivetPnpInstall(rivetRootDir) {
  return (
    fs.existsSync(path.join(rivetRootDir, '.pnp.cjs')) &&
    fs.existsSync(path.join(rivetRootDir, '.yarn', 'install-state.gz'))
  );
}

export function clearEmbeddedRivetPnpArtifacts(wrapperRootDir, rivetRootDir) {
  if (isExternalRivetWorkspace(wrapperRootDir, rivetRootDir)) {
    return false;
  }

  const artifactPaths = [
    path.join(rivetRootDir, '.pnp.cjs'),
    path.join(rivetRootDir, '.pnp.loader.mjs'),
    path.join(rivetRootDir, '.yarn', 'install-state.gz'),
  ];
  let cleared = false;

  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath)) {
      continue;
    }

    fs.unlinkSync(artifactPath);
    cleared = true;
  }

  return cleared;
}

export function getRivetYarnEnvironment(wrapperRootDir, rivetRootDir) {
  // An embedded snapshot belongs to this wrapper and keeps the node-modules
  // layout used by its Vite/runtime overlays. A linked checkout belongs to its
  // own repository, so preserve that checkout's configured Yarn linker.
  return isExternalRivetWorkspace(wrapperRootDir, rivetRootDir)
    ? {}
    : { YARN_NODE_LINKER: 'node-modules' };
}
