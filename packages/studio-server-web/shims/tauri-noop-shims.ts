export async function getVersion(): Promise<string> {
  return 'hosted';
}

export async function getName(): Promise<string> {
  return 'Rivet (Hosted)';
}

export async function getTauriVersion(): Promise<string> {
  return '0.0.0';
}

export async function register(_shortcut: string, _handler: () => void): Promise<void> {
}

export async function unregister(_shortcut: string): Promise<void> {
}

export async function unregisterAll(): Promise<void> {
}

export function isRegistered(_shortcut: string): Promise<boolean> {
  return Promise.resolve(false);
}

export async function relaunch(): Promise<void> {
  window.location.reload();
}

export async function exit(_code?: number): Promise<void> {
}

export interface UpdateManifest {
  version: string;
  date?: string;
  body?: string;
}

export interface UpdateResult {
  shouldUpdate: boolean;
  manifest?: UpdateManifest;
}

export type UpdateStatusResult = {
  error?: string;
  status: 'PENDING' | 'ERROR' | 'DONE' | 'UPTODATE';
};

export async function checkUpdate(): Promise<UpdateResult> {
  return { shouldUpdate: false };
}

export async function installUpdate(): Promise<void> {
}

export function onUpdaterEvent(
  _handler: (status: UpdateStatusResult) => void,
): Promise<() => void> {
  return Promise.resolve(() => {});
}
