import { AsyncLocalStorage } from 'node:async_hooks';
import { LocalUpgradeDiagnosticError } from './upgrade-diagnostics.js';

// Limits decoded source material per project (including history), recording
// bundle, settings import, or library archive, not per installation.
const budgets = new AsyncLocalStorage<{ used: number; limit: number }>();
const selectedLimits = new AsyncLocalStorage<number>();
export function localSourceBundleLimit(): number {
  const selected = selectedLimits.getStore();
  if (selected !== undefined) return selected;
  const mib = Number(process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB || 32);
  if (!Number.isInteger(mib) || mib < 1 || mib > 128) throw new Error('Local source bundle budget must be 1–128 MiB.');
  return mib * 1048576;
}
/** Restore selects one bounded, capacity-checked limit for all independent source readers. */
export function withLocalSourceBundleLimit<T>(limit: number, read: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(limit) || limit < 1048576 || limit > 128 * 1048576)
    throw new Error('Invalid selected source bundle budget.');
  return selectedLimits.run(limit, read);
}
export function withLocalSourceBudget<T>(read: () => Promise<T>, options: { reuse?: boolean } = {}): Promise<T> {
  if (options.reuse && budgets.getStore()) return read();
  return budgets.run({ used: 0, limit: localSourceBundleLimit() }, read);
}
export function chargeLocalSourceBytes(bytes: number): void {
  const budget = budgets.getStore();
  if (!budget) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || budget.used + bytes > budget.limit)
    throw new LocalUpgradeDiagnosticError('source-bundle-limit');
  budget.used += bytes;
}
export function remainingLocalSourceBytes(): number | undefined {
  const budget = budgets.getStore();
  return budget && budget.limit - budget.used;
}
