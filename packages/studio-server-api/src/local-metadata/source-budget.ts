import { AsyncLocalStorage } from 'node:async_hooks';

// Limits decoded source material per project (including history), recording
// bundle, settings import, or library archive, not per installation.
const budgets = new AsyncLocalStorage<{ used: number; limit: number }>();
export function localSourceBundleLimit(): number {
  const mib = Number(process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB || 32);
  if (!Number.isInteger(mib) || mib < 1 || mib > 128) throw new Error('Local source bundle budget must be 1–128 MiB.');
  return mib * 1048576;
}
export function withLocalSourceBudget<T>(read: () => Promise<T>): Promise<T> {
  return budgets.run({ used: 0, limit: localSourceBundleLimit() }, read);
}
export function chargeLocalSourceBytes(bytes: number): void {
  const budget = budgets.getStore();
  if (!budget) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || budget.used + bytes > budget.limit)
    throw new Error('Local source bundle exceeds the decoded-memory budget; legacy storage remains selected.');
  budget.used += bytes;
}
export function remainingLocalSourceBytes(): number | undefined {
  const budget = budgets.getStore();
  return budget && budget.limit - budget.used;
}
