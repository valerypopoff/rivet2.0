import fs from 'node:fs';
import path from 'node:path';

const pnpPreloadOptionPattern =
  /(?:^|\s)(?:--require|--import|--experimental-loader)(?:=|\s+)(?:"[^"]*\.pnp(?:\.loader)?\.(?:cjs|mjs)"|'[^']*\.pnp(?:\.loader)?\.(?:cjs|mjs)'|[^\s]*\.pnp(?:\.loader)?\.(?:cjs|mjs))/gi;

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

export function stripPnpNodeOptions(nodeOptions = '') {
  return nodeOptions.replace(pnpPreloadOptionPattern, ' ').replace(/\s+/g, ' ').trim();
}

export function clearEmbeddedRivetPnpLoaders(wrapperRootDir, rivetRootDir) {
  if (isExternalRivetWorkspace(wrapperRootDir, rivetRootDir)) {
    return false;
  }

  const loaderPaths = [
    path.join(rivetRootDir, '.pnp.cjs'),
    path.join(rivetRootDir, '.pnp.loader.mjs'),
  ];
  let cleared = false;

  for (const loaderPath of loaderPaths) {
    if (!fs.existsSync(loaderPath)) {
      continue;
    }

    fs.unlinkSync(loaderPath);
    cleared = true;
  }

  return cleared;
}

export function ensureEmbeddedRivetNodeModulesConfig(wrapperRootDir, rivetRootDir) {
  if (isExternalRivetWorkspace(wrapperRootDir, rivetRootDir)) {
    return false;
  }

  const yarnrcPath = path.join(rivetRootDir, '.yarnrc.yml');
  const yarnrc = fs.readFileSync(yarnrcPath, 'utf8');
  const nodeLinkerPattern = /^nodeLinker:.*$/m;
  const nextYarnrc = nodeLinkerPattern.test(yarnrc)
    ? yarnrc.replace(nodeLinkerPattern, 'nodeLinker: node-modules')
    : `${yarnrc.trimEnd()}\n\nnodeLinker: node-modules\n`;

  if (nextYarnrc === yarnrc) {
    return false;
  }

  fs.writeFileSync(yarnrcPath, nextYarnrc, 'utf8');
  return true;
}

export function getRivetYarnEnvironment(wrapperRootDir, rivetRootDir) {
  // An embedded snapshot belongs to this wrapper and keeps the node-modules
  // layout used by its Vite/runtime overlays. A linked checkout belongs to its
  // own repository, so preserve its package-manager and Node configuration.
  if (isExternalRivetWorkspace(wrapperRootDir, rivetRootDir)) {
    return {};
  }

  return {
    NODE_OPTIONS: stripPnpNodeOptions(process.env.NODE_OPTIONS),
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
