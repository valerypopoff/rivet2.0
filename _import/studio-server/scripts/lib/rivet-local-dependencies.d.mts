export function isExternalRivetWorkspace(wrapperRootDir: string, rivetRootDir: string): boolean;

export function hasRivetPnpInstall(rivetRootDir: string): boolean;

export function stripPnpNodeOptions(nodeOptions?: string): string;

export function clearPnpLoaders(workspaceRootDir: string): boolean;

export function clearEmbeddedRivetPnpLoaders(
  wrapperRootDir: string,
  rivetRootDir: string,
): boolean;

export function ensureWorkspaceNodeModulesConfig(workspaceRootDir: string): boolean;

export function ensureEmbeddedRivetNodeModulesConfig(
  wrapperRootDir: string,
  rivetRootDir: string,
): boolean;

export function getRivetYarnEnvironment(
  wrapperRootDir: string,
  rivetRootDir: string,
): Record<string, string>;

export function getRivetYarnInvocation(rivetRootDir: string): {
  command: string;
  args: string[];
};
