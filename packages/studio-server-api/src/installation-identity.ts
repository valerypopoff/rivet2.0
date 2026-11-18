/** Restore/deployment IDs are opaque text, not paths or Kubernetes names. */
export function isInstallationIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !value.includes('\0');
}
