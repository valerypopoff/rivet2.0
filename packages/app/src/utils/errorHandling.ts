import { getError } from '@valerypopoff/rivet2-core';
import { toast } from 'react-toastify';

const recentErrorTimestamps = new Map<string, number>();
const ERROR_DEDUPE_WINDOW_MS = 5_000;
const IGNORED_BROWSER_ERROR_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
  'webview not found: invalid label or it was closed',
]);

export type HandleErrorOptions = {
  metadata?: Record<string, unknown>;
  toastError?: boolean;
};

type HandleErrorOptionsResolver<TArgs extends unknown[]> =
  | HandleErrorOptions
  | ((...args: TArgs) => HandleErrorOptions);

function getBrowserErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error != null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }

  return undefined;
}

export function isIgnoredBrowserError(error: unknown): boolean {
  const message = getBrowserErrorMessage(error)?.trim();
  return message != null && IGNORED_BROWSER_ERROR_MESSAGES.has(message);
}

export function handleError(error: unknown, context: string, options: HandleErrorOptions = {}): void {
  const normalizedError = getError(error);
  const message = `${context}: ${normalizedError.message}`;

  if (options.metadata) {
    console.error(`[${context}]`, {
      error: normalizedError,
      metadata: options.metadata,
    });
  } else {
    console.error(`[${context}]`, normalizedError);
  }

  if (options.toastError === false) {
    return;
  }

  const now = Date.now();
  const lastShownAt = recentErrorTimestamps.get(message) ?? 0;
  if (now - lastShownAt < ERROR_DEDUPE_WINDOW_MS) {
    return;
  }

  recentErrorTimestamps.set(message, now);
  toast.error(message);
}

export function wrapAsync<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  context: string,
  options?: HandleErrorOptionsResolver<TArgs>,
): (...args: TArgs) => void {
  return (...args: TArgs) => {
    void fn(...args).catch((error) => {
      handleError(error, context, typeof options === 'function' ? options(...args) : options);
    });
  };
}

export function installGlobalErrorHandlers(): void {
  const windowWithFlag = window as Window & { __rivetGlobalErrorHandlersInstalled?: boolean };
  if (windowWithFlag.__rivetGlobalErrorHandlersInstalled) {
    return;
  }

  windowWithFlag.__rivetGlobalErrorHandlersInstalled = true;

  window.addEventListener('unhandledrejection', (event) => {
    if (isIgnoredBrowserError(event.reason)) {
      event.preventDefault();
      return;
    }

    handleError(event.reason, 'Unhandled promise rejection');
  });

  window.addEventListener('error', (event) => {
    if (isIgnoredBrowserError(event.error) || isIgnoredBrowserError(event.message)) {
      event.preventDefault();
      return;
    }

    handleError(event.error ?? event.message, 'Unhandled error');
  });
}
