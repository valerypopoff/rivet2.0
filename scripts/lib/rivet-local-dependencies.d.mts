export function isExternalRivetWorkspace(wrapperRootDir: string, rivetRootDir: string): boolean;

export function hasRivetPnpInstall(rivetRootDir: string): boolean;

export function clearEmbeddedRivetPnpArtifacts(
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
