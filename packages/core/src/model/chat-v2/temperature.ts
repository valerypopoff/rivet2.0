/** Empty historical editor values are unset, never the provider's explicit zero. */
export function normalizeTemperature(value: unknown, label = 'Temperature'): number | undefined {
  if (value == null || (typeof value === 'number' && Number.isNaN(value))) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number when provided.`);
  }
  return value;
}
