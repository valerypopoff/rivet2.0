import { randomUUID } from 'node:crypto';

/** Qualification fixtures create new root items, never overwrite discovered data.
 * Old non-strict JSON readers ignore this additive field; new readers require it. */
export const rootStructuralMutation = () => ({
  operationId: randomUUID(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  expectedDestinationId: null,
});
