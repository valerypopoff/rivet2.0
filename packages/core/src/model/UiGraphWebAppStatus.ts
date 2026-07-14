import type { DataValue } from './DataValue.js';
import type { ExternalFunction } from './GraphProcessor.js';

export const RIVET_WEB_APP_STATUS_FUNCTION_NAME = 'setWebAppStatus';

/** Built-in External Call function used to report web-app status. */
export const rivetWebAppStatusExternalFunction: ExternalFunction = async (context, value) => {
  const message = formatRivetWebAppStatusMessage(value);
  context.reportProgress({ message });
  return { type: 'string', value: message } satisfies DataValue;
};

export function formatRivetWebAppStatusMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[Unserializable web app status]';
  }
}
