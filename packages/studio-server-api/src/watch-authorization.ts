import type { Request, Response } from 'express';
import { runOutsideAppSettingsSnapshot } from './app-settings/settings-repository.js';
import { isServerUiAuthRequestAllowed } from './server-ui-auth.js';
import { trustedClientSettingsRepository } from './trusted-client-settings.js';
import { webAppAuthSettingsRepository } from './web-app-auth-settings.js';

/** Changes revoke immediately on this replica; the timer also catches expiry/errors. */
export function watchAuthorization(allowed: () => boolean, revoke: () => void): () => void {
  let stopped = false;
  const check = () => {
    if (stopped) return;
    let authorized = false;
    try {
      authorized = runOutsideAppSettingsSnapshot(allowed);
    } catch {
      // Unavailable policy must never preserve authorization.
    }
    if (!authorized) {
      stop();
      revoke();
    }
  };
  const offClients = trustedClientSettingsRepository.subscribe(check);
  const offOAuth = webAppAuthSettingsRepository.subscribe(check);
  const timer = setInterval(check, 5_000);
  timer.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    offClients();
    offOAuth();
    clearInterval(timer);
  };
  check();
  return stop;
}

/** Keep operator event streams authorized for their entire response lifetime. */
export function watchOperatorStreamAuthorization(request: Request, response: Response): boolean {
  if (response.destroyed || response.writableEnded) return false;
  const stop = watchAuthorization(() => isServerUiAuthRequestAllowed(request), () => {
    if (!response.headersSent) response.status(403);
    response.end();
  });
  const cleanup = () => {
    stop();
    response.off('close', cleanup);
    response.off('finish', cleanup);
  };
  response.once('close', cleanup);
  response.once('finish', cleanup);
  if (response.destroyed || response.writableEnded) {
    cleanup();
    return false;
  }
  return true;
}
