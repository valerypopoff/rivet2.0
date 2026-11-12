import { parseJsonResponse } from './apiRequest';
export async function readBundleComparison<T>(
  kind: 'manifest' | 'pair',
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return parseJsonResponse<T>(
    await fetch(`/api/workflows/bundles/compare/${kind}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Rivet-Bundle-Intent': '1' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }),
  );
}
