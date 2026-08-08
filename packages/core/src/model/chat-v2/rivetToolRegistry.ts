import type { GptFunction } from '../DataValue.js';

/**
 * Canonical Rivet tool declaration lookup. Provider projections historically
 * use last declaration wins for duplicate names; retain that compatibility in
 * one explicit place.
 */
export type RivetToolRegistry = {
  byName: ReadonlyMap<string, GptFunction>;
  names: ReadonlySet<string>;
};

export function createRivetToolRegistry(functions: readonly GptFunction[] | undefined): RivetToolRegistry {
  const byName = new Map<string, GptFunction>();
  for (const tool of functions ?? []) {
    if (typeof tool.name === 'string' && tool.name.trim().length > 0) {
      byName.set(tool.name, tool);
    }
  }
  return { byName, names: new Set(byName.keys()) };
}
