type ModuleLoader<Module> = () => Promise<Module>;

/** Only recover fetch failures from this immutable asset namespace. Evaluation
 * errors must not execute another copy of a module with partial side effects. */
export function getRetryableModuleUrl(error: unknown, baseUrl: string): URL | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(
    /^(?:Failed to fetch dynamically imported module:|error loading dynamically imported module:)\s*(\S+)$/i,
  );
  if (!match) return undefined;
  try {
    const url = new URL(match[1]!);
    const base = new URL('.', baseUrl);
    if (
      url.origin !== base.origin ||
      url.protocol !== base.protocol ||
      !url.pathname.startsWith(base.pathname) ||
      /%2f|%5c/i.test(url.pathname) ||
      !/\.(?:js|mjs|tsx?)$/.test(url.pathname) ||
      url.username ||
      url.password
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function createRetryableModuleLoader<Module>(
  original: ModuleLoader<Module>,
  baseUrl = import.meta.url,
  importModule: (url: string) => Promise<Module> = (url) => import(/* @vite-ignore */ url),
) {
  let pending: Promise<Module> | undefined;
  let failed = false;
  let failedUrl: URL | undefined;
  let attempt = 0;
  const track = (load: ModuleLoader<Module>) => {
    failed = false;
    // Assign the shared promise before invoking user/module code. A loader may
    // throw synchronously even though its normal return type is a promise.
    pending = Promise.resolve()
      .then(load)
      .then(
        (module) => {
          failedUrl = undefined;
          return module;
        },
        (error: unknown) => {
          failed = true;
          failedUrl = getRetryableModuleUrl(error, baseUrl);
          throw error;
        },
      );
    return pending;
  };
  return {
    load: () => pending ?? track(original),
    retry: () => {
      if (pending && !failed) return pending;
      if (!failedUrl) return track(original);
      const url = new URL(failedUrl);
      url.searchParams.set('__rivet_import_retry', String(++attempt));
      // Pathname/build namespace stay unchanged. Only a failed fetch is retried
      // on explicit intent; successful shared dependencies stay cached.
      return track(() => importModule(url.href));
    },
  };
}
