import { LocalUpgradeDiagnosticError } from './upgrade-diagnostics.js';

/** Shared by source inspection and catalog writes: preferences are not routes. */
export class LocalWorkflowRouteClaims {
  #endpoints = new Map<string, string>();
  #slugs = new Set<string>();

  endpoint(workflowId: string, name: string): void {
    if (!name) return;
    const key = name.toLowerCase(),
      owner = this.#endpoints.get(key);
    if (owner !== undefined && owner !== workflowId) this.#collision('endpoint');
    this.#endpoints.set(key, workflowId);
  }

  webApp(slug: string): void {
    const key = slug.toLowerCase();
    if (this.#slugs.has(key)) this.#collision('web-app slug');
    this.#slugs.add(key);
  }

  #collision(kind: string): never {
    throw new LocalUpgradeDiagnosticError(
      'publication-route-conflict',
      undefined,
      undefined,
      `Local workflow ${kind} already exists (case-insensitive route collision).`,
    );
  }
}
