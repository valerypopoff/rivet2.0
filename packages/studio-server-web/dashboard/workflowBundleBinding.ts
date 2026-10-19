import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';

export function workflowBundleKey(bundleId: string | null | undefined): string | null {
  return bundleId ? `${new URL(RIVET_API_BASE_URL, window.location.href).href}#bundle:${bundleId}` : null;
}
