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
  // layout used by its Vite/runtime overlays. Clear inherited NODE_OPTIONS so
  // a parent Yarn PnP preload cannot attach a stale loader to this snapshot.
  // A linked checkout belongs to its own repository, so preserve its own
  // package-manager and Node runtime configuration.
  return isExternalRivetWorkspace(wrapperRootDir, rivetRootDir)
    ? {}
    : {
        NODE_OPTIONS: '',
        YARN_NODE_LINKER: 'node-modules',
      };
}

export function getRivetYarnInvocation(rivetRootDir) {
  const yarnrcPath = path.join(rivetRootDir, '.yarnrc.yml');
  const yarnrc = fs.readFileSync(yarnrcPath, 'utf8');
  const configuredPath = /^yarnPath:\s*(\S+)\s*$/m.exec(yarnrc)?.[1];

  if (!configuredPath) {
    throw new Error(`[rivet-dependencies] Expected yarnPath in ${yarnrcPath}`);
  }

  const yarnPath = path.resolve(rivetRootDir, configuredPath);
  if (!isPathInside(rivetRootDir, yarnPath) || !fs.existsSync(yarnPath)) {
    throw new Error(`[rivet-dependencies] Expected configured Yarn release at ${yarnPath}`);
  }

  return {
    command: process.execPath,
    args: [yarnPath],
  };
}
