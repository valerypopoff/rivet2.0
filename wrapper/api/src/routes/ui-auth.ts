import { Router, type Request, type Response } from 'express';
import { getExpectedUiSessionToken, isTrustedProxyRequest, isValidSharedKey } from '../auth.js';
import { createHttpError } from '../utils/httpError.js';

export const uiAuthRouter = Router();
const defaultUiReturnTo = '/';

function isFormPost(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded');
}

function setNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

export function sanitizeUiAuthReturnTo(value: unknown): string {
  if (typeof value !== 'string') {
    return defaultUiReturnTo;
  }

  const candidate = value.trim();
  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    /[\u0000-\u001f\u007f\\]/.test(candidate)
  ) {
    return defaultUiReturnTo;
  }

  try {
    const parsed = new URL(candidate, 'http://rivet.local');
    if (parsed.origin !== 'http://rivet.local') {
      return defaultUiReturnTo;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}` || defaultUiReturnTo;
  } catch {
    return defaultUiReturnTo;
  }
}

export function addUiAuthErrorToReturnTo(returnTo: string, authError: string): string {
  const parsed = new URL(sanitizeUiAuthReturnTo(returnTo), 'http://rivet.local');
  parsed.searchParams.set('auth_error', authError);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || defaultUiReturnTo;
}

function getFormReturnTo(req: Request): string {
  return sanitizeUiAuthReturnTo(req.body?.return_to);
}

function redirectFormError(res: Response, returnTo: string, authError: string): void {
  res.redirect(303, addUiAuthErrorToReturnTo(returnTo, authError));
}

uiAuthRouter.post('/ui-auth', (req, res, next) => {
  const formPost = isFormPost(req.get('content-type'));
  const formReturnTo = getFormReturnTo(req);
  setNoStoreHeaders(res);

  if (!isTrustedProxyRequest(req)) {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'forbidden');
      return;
    }
    next(createHttpError(403, 'Forbidden'));
    return;
  }

  const configuredKey = process.env.RIVET_KEY?.trim();
  if (!configuredKey) {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'unavailable');
      return;
    }
    next(createHttpError(500, 'UI access key is not configured'));
    return;
  }

  const providedKey = typeof req.body?.key === 'string'
    ? req.body.key
    : typeof req.body?.token === 'string'
      ? req.body.token
      : '';
  if (!isValidSharedKey(providedKey)) {
    if (formPost) {
      redirectFormError(res, formReturnTo, 'invalid');
      return;
    }
    next(createHttpError(401, 'Invalid access key'));
    return;
  }

  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto?.split(',')[0]?.trim().toLowerCase() || req.protocol || 'http';
  const secureSuffix = protocol === 'https' ? '; Secure' : '';
  const sessionToken = getExpectedUiSessionToken();

  res.setHeader('Set-Cookie', `rivet_ui_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secureSuffix}`);
  if (formPost) {
    res.redirect(303, formReturnTo);
    return;
  }

  res.status(204).end();
});
