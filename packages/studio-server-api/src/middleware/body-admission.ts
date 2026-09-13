import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { recordStudioMetrics } from '../metrics.js';
import { createHttpError } from '../utils/httpError.js';

// A request's decoded body can temporarily occupy substantially more memory
// than its wire representation. Four concurrent parsers is deliberately a
// small, process-wide ceiling; it is separate from graph-execution admission.
export const MAX_CONCURRENT_HTTP_BODY_PARSERS = 4;
export const MAX_RESERVED_HTTP_BODY_BYTES = 1024 * 1024 * 1024;
/** Bound receipt separately from the lifetime of a successful graph execution. */
export const DEFAULT_HTTP_BODY_RECEIVE_TIMEOUT_MS = 120_000;
/**
 * Let a client receive a pre-body rejection while draining no more than a
 * brief amount of its already-started upload before closing the connection.
 */
const REJECTED_BODY_DRAIN_GRACE_MS = 250;
const IMMEDIATE_REJECTION_CLOSE_MAX_BYTES = 8 * 1024;
/** @deprecated Use MAX_CONCURRENT_HTTP_BODY_PARSERS. */
export const MAX_CONCURRENT_JSON_BODY_PARSERS = MAX_CONCURRENT_HTTP_BODY_PARSERS;
/** @deprecated Use MAX_RESERVED_HTTP_BODY_BYTES. */
export const MAX_RESERVED_JSON_BODY_BYTES = MAX_RESERVED_HTTP_BODY_BYTES;

export type HttpBodyAdmissionSnapshot = Readonly<{
  activeParsers: number;
  maxActiveParsers: number;
  maxReservedBytes: number;
  reservedBytes: number;
  retainedBodies: number;
}>;

type BodyReservation = {
  isRetained: () => boolean;
  release: () => void;
  releaseParserSlot: () => void;
  retain: () => void;
};

const requestReservations = new WeakMap<Request, BodyReservation>();
// Both route middleware and the final error formatter can see the same
// pre-body rejection. Keep closing response-owned so the second observer does
// not install another drain timer or resume the upload a second time.
const scheduledConnectionCloses = new WeakSet<Response>();

/**
 * Rejecting before a request body has been consumed must not keep a reusable
 * connection open for the client to continue uploading that rejected body.
 * Flush the useful HTTP response first, then terminate this connection.
 */
export function closeResponseConnectionAfterFlush(res: Response, req?: Request): void {
  if (res.destroyed || scheduledConnectionCloses.has(res)) {
    return;
  }
  scheduledConnectionCloses.add(res);

  // Let Node own the terminal close after it has flushed the error response.
  // Calling socket.end() from response lifecycle hooks can race the queued
  // response bytes and turn a valid 413 into ECONNRESET at the client.
  if (!res.headersSent) res.setHeader('Connection', 'close');
  res.shouldKeepAlive = false;

  // A small or complete request needs no bounded drain. For a larger open
  // upload, discard a short grace window so the client can receive its error
  // response without leaving the server in an unbounded receiving state.
  const declaredBytes = req ? readContentLength(req) : undefined;
  if (!req || req.complete || (declaredBytes != null && declaredBytes <= IMMEDIATE_REJECTION_CLOSE_MAX_BYTES)) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    req.off('end', cleanup);
    req.off('aborted', cleanup);
    res.off('finish', cleanup);
    res.off('close', cleanup);
  };

  req.once('end', cleanup);
  req.once('aborted', cleanup);
  res.once('finish', cleanup);
  res.once('close', cleanup);
  timeout = setTimeout(() => {
    // Stop accepting discarded bytes after the bounded grace period. Node
    // sends the already-marked terminal response and then closes the socket.
    req.pause();
  }, REJECTED_BODY_DRAIN_GRACE_MS);
  timeout.unref();
  // Discard bytes without constructing a parsed body. The grace period bounds
  // this work and ensures a valid error response can reach ordinary clients.
  req.resume();
}

export function isJsonRequest(req: Request): boolean {
  const contentType = req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  return contentType === 'application/json' || /^application\/[!#$%&'*+.^_`|~0-9a-z-]*\+json$/.test(contentType ?? '');
}

export function isUrlEncodedRequest(req: Request): boolean {
  return req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function hasRequestBody(req: Request): boolean {
  const contentLength = readContentLength(req);
  if (contentLength != null && contentLength > 0) {
    return true;
  }

  // Chunked requests have no useful Content-Length. Treat any declared
  // transfer encoding as a body-bearing request so an unsupported media type
  // cannot leave an unconsumed stream behind a route handler.
  return Boolean(req.get('transfer-encoding')?.trim());
}

function readContentLength(req: Request): number | null {
  const raw = req.get('content-length')?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function hasNonIdentityContentEncoding(req: Request): boolean {
  const contentEncoding = req.get('content-encoding')?.trim().toLowerCase();
  return Boolean(contentEncoding && contentEncoding !== 'identity');
}

function reservationBytesForRequest(req: Request, limitBytes: number): number {
  // A compressed request can inflate to the parser's complete decoded limit,
  // so its Content-Length cannot safely reduce the reservation.
  if (hasNonIdentityContentEncoding(req)) {
    return limitBytes;
  }

  const contentLength = readContentLength(req);
  return contentLength == null ? limitBytes : Math.min(contentLength, limitBytes);
}

export class HttpBodyAdmissionController {
  #activeParsers = 0;
  #reservedBytes = 0;
  #retainedBodies = 0;

  getSnapshot(): HttpBodyAdmissionSnapshot {
    return Object.freeze({
      activeParsers: this.#activeParsers,
      maxActiveParsers: MAX_CONCURRENT_HTTP_BODY_PARSERS,
      maxReservedBytes: MAX_RESERVED_HTTP_BODY_BYTES,
      reservedBytes: this.#reservedBytes,
      retainedBodies: this.#retainedBodies,
    });
  }

  admit(req: Request, limitBytes: number): BodyReservation | null {
    const contentLength = readContentLength(req);
    // Reject declared identity size before reading; the bounded transport
    // reader enforces the decoded limit for compressed content.
    if (!hasNonIdentityContentEncoding(req) && contentLength != null && contentLength > limitBytes) {
      recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('too_large'));
      throw createHttpError(413, "Request body exceeds this route's allowed size.", {
        expose: true,
        code: 'body_too_large',
        closeConnection: true,
      });
    }

    const reservationBytes = reservationBytesForRequest(req, limitBytes);
    if (
      this.#activeParsers >= MAX_CONCURRENT_HTTP_BODY_PARSERS ||
      reservationBytes > MAX_RESERVED_HTTP_BODY_BYTES ||
      this.#reservedBytes + reservationBytes > MAX_RESERVED_HTTP_BODY_BYTES
    ) {
      recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('capacity_exceeded'));
      return null;
    }

    this.#activeParsers += 1;
    this.#reservedBytes += reservationBytes;
    let parserSlotReleased = false;
    let released = false;
    let retained = false;

    const releaseParserSlot = () => {
      if (parserSlotReleased) {
        return;
      }
      parserSlotReleased = true;
      this.#activeParsers = Math.max(0, this.#activeParsers - 1);
    };

    return {
      isRetained: () => retained,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        releaseParserSlot();
        this.#reservedBytes = Math.max(0, this.#reservedBytes - reservationBytes);
        if (retained) {
          this.#retainedBodies = Math.max(0, this.#retainedBodies - 1);
        }
      },
      releaseParserSlot,
      retain: () => {
        if (released || retained) {
          return;
        }
        retained = true;
        this.#retainedBodies += 1;
      },
    };
  }
}

const defaultHttpBodyAdmissionController = new HttpBodyAdmissionController();

export function getHttpBodyAdmissionSnapshot(): HttpBodyAdmissionSnapshot {
  return defaultHttpBodyAdmissionController.getSnapshot();
}

/**
 * A handler that keeps a parsed body while graph execution unwinds retains its
 * byte reservation until its own finally block. Ordinary request handlers need
 * no special action: their reservation is released when the response ends.
 */
export function retainParsedRequestBody(req: Request): () => void {
  const reservation = requestReservations.get(req);
  if (!reservation) {
    return () => {};
  }

  reservation.retain();
  return reservation.release;
}

export function createAdmittedBodyParser(options: {
  getLimitBytes: (req: Request) => number;
  shouldParse: (req: Request) => boolean;
  parse: (
    req: Request,
    res: Response,
    next: NextFunction,
    limitBytes: number,
    signal: AbortSignal,
    markBodyReceived: () => void,
  ) => void;
  controller?: HttpBodyAdmissionController;
  receiveTimeoutMs?: number;
  /**
   * Routes that accept a body only in one of their declared representations
   * must reject other body-bearing requests before their handler runs. Routes
   * with no body retain their existing validation response.
   */
  rejectUnsupportedMediaType?: boolean;
}): RequestHandler {
  const controller = options.controller ?? defaultHttpBodyAdmissionController;

  return (req, res, next) => {
    // Avoid reparsing a route-specific body.
    if (req.body !== undefined) {
      next();
      return;
    }

    if (!options.shouldParse(req)) {
      if (options.rejectUnsupportedMediaType && hasRequestBody(req)) {
        recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('unsupported_media_type'));
        next(
          createHttpError(415, 'Request body uses an unsupported media type.', {
            expose: true,
            code: 'unsupported_media_type',
            closeConnection: true,
          }),
        );
        return;
      }
      next();
      return;
    }

    const limitBytes = options.getLimitBytes(req);
    let reservation: BodyReservation;
    try {
      const admitted = controller.admit(req, limitBytes);
      if (!admitted) {
        next(
          createHttpError(503, 'Request body capacity is temporarily exhausted.', {
            expose: true,
            code: 'body_capacity_exhausted',
            retryAfterSeconds: 1,
            closeConnection: true,
          }),
        );
        return;
      }
      reservation = admitted;
    } catch (error) {
      next(error);
      return;
    }

    requestReservations.set(req, reservation);
    let parsingSettled = false;
    const cancellation = new AbortController();
    const releaseIfNotRetained = () => {
      if (parsingSettled && !reservation.isRetained()) {
        reservation.release();
      }
    };
    res.once('finish', releaseIfNotRetained);
    res.once('close', releaseIfNotRetained);

    let bodyReceived = false;
    const receiveTimeout = setTimeout(() => {
      cancellation.abort(
        createHttpError(408, 'Request body was not received in time.', {
          expose: true,
          code: 'body_receive_timeout',
          closeConnection: true,
        }),
      );
    }, options.receiveTimeoutMs ?? DEFAULT_HTTP_BODY_RECEIVE_TIMEOUT_MS);
    receiveTimeout.unref();

    const markBodyReceived = () => {
      if (bodyReceived) return;
      bodyReceived = true;
      clearTimeout(receiveTimeout);
    };

    const settle = (error?: unknown) => {
      if (parsingSettled) {
        return;
      }
      parsingSettled = true;
      clearTimeout(receiveTimeout);
      req.off('aborted', abortParsing);
      res.off('close', abortParsing);
      if (error) {
        const status = (error as { status?: unknown }).status;
        if (status === 413) {
          recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('too_large'));
          (error as { code?: string }).code = 'body_too_large';
          (error as { expose?: boolean }).expose = true;
        }
        if (status === 408) {
          recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('receive_timeout'));
        }
        if (status === 415) {
          recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('unsupported_body_encoding'));
          (error as { code?: string }).code ??= 'unsupported_body_encoding';
          (error as { expose?: boolean }).expose = true;
        }
        if ((error as { closeConnection?: unknown }).closeConnection === true) {
          closeResponseConnectionAfterFlush(res, req);
        }
        reservation.release();
        if (res.destroyed) {
          return;
        }
        next(error);
        return;
      }
      // Parsing has finished. Long-running handlers can retain only their
      // body's byte reservation; they must not consume one of the four
      // expensive parsing slots for the lifetime of graph execution.
      reservation.releaseParserSlot();
      next();
    };

    const abortParsing = () => {
      cancellation.abort(createHttpError(400, 'Request body was aborted.', { expose: true, closeConnection: true }));
    };
    req.once('aborted', abortParsing);
    res.once('close', abortParsing);
    if (res.destroyed) abortParsing();

    try {
      options.parse(req, res, settle, limitBytes, cancellation.signal, markBodyReceived);
    } catch (error) {
      settle(error);
    }
  };
}

export function createAdmittedJsonBodyParser(
  options: Omit<Parameters<typeof createAdmittedBodyParser>[0], 'shouldParse'>,
): RequestHandler {
  return createAdmittedBodyParser({ ...options, shouldParse: isJsonRequest });
}
