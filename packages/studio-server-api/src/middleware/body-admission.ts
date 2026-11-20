import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { performance } from 'node:perf_hooks';

import { recordStudioMetrics, type MetricsHttpBodyWaitOutcome } from '../metrics.js';
import { createHttpError } from '../utils/httpError.js';

// A request's decoded body can temporarily occupy substantially more memory
// than its wire representation. Four concurrent parsers is deliberately a
// small, process-wide ceiling; it is separate from graph-execution admission.
export const MAX_CONCURRENT_HTTP_BODY_PARSERS = 4;
export const MAX_RESERVED_HTTP_BODY_BYTES = 1024 * 1024 * 1024;
export const MAX_QUEUED_HTTP_BODIES = 64;
export const HTTP_BODY_ADMISSION_WAIT_MS = 1_000;
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
  queuedRequests: number;
  maxQueuedRequests: number;
}>;

export type BodyReservation = {
  isRetained: () => boolean;
  release: () => void;
  releaseParserSlot: () => void;
  retain: () => void;
  finalizeDecodedBytes: (bytes: number) => void;
};

type WaitingBody = {
  bytes: number;
  startedAt: number;
  deadline: number;
  receiveDeadline?: number;
  signal?: AbortSignal;
  abort: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (reservation: BodyReservation) => void;
  reject: (error: unknown) => void;
};

function bodyCapacityError() {
  recordStudioMetrics((metrics) => metrics.recordHttpBodyAdmission('capacity_exceeded'));
  return createHttpError(503, 'Request body capacity is temporarily exhausted.', {
    expose: true,
    code: 'body_capacity_exhausted',
    retryAfterSeconds: 1,
    closeConnection: true,
  });
}

function bodyReceiveTimeoutError() {
  return createHttpError(408, 'Request body was not received in time.', {
    expose: true,
    code: 'body_receive_timeout',
    closeConnection: true,
  });
}

function bodyAbortedError() {
  return createHttpError(400, 'Request body was aborted.', { expose: true, closeConnection: true });
}

const requestReservations = new WeakMap<Request, BodyReservation>();
// Both route middleware and the final error formatter can see the same
// pre-body rejection. Keep closing response-owned so the second observer does
// not install another drain timer or resume the upload a second time.
const scheduledConnectionCloses = new WeakMap<Response, Promise<void>>();

/**
 * Prepare a terminal connection before throwing to an error formatter.
 * Direct replies should use sendRejectedBodyResponse so they wait for the
 * bounded discard instead of closing over an in-flight upload.
 */
export function closeResponseConnectionAfterFlush(res: Response, req?: Request): void {
  void prepareRejectedBodyResponse(res, req);
}

/** Send a terminal pre-body response only after the bounded discard is ready. */
export function sendRejectedBodyResponse(req: Request, res: Response, send: () => void): void {
  if (res.destroyed || res.writableEnded) return;
  void prepareRejectedBodyResponse(res, req)
    .then(() => {
      if (!res.destroyed && !res.writableEnded) send();
    })
    .catch((error: unknown) => {
      // A failed terminal reply must not become an unhandled promise or start
      // another response. Keep diagnostics on the server and close the socket.
      console.error('Failed to send a rejected request response:', error);
      res.destroy();
    });
}

/** Share one bounded discard between a route and its final error formatter. */
function prepareRejectedBodyResponse(res: Response, req?: Request): Promise<void> {
  const scheduled = scheduledConnectionCloses.get(res);
  if (scheduled) return scheduled;
  if (res.destroyed) return Promise.resolve();

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
    const complete = Promise.resolve();
    scheduledConnectionCloses.set(res, complete);
    return complete;
  }

  const pending = new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timeout);
      req.off('end', cleanup);
      req.off('aborted', cleanup);
      res.off('finish', cleanup);
      res.off('close', cleanup);
      resolve();
    };
    const timeout = setTimeout(() => {
      req.pause();
      cleanup();
    }, REJECTED_BODY_DRAIN_GRACE_MS);
    timeout.unref();
    req.once('end', cleanup);
    req.once('aborted', cleanup);
    res.once('finish', cleanup);
    res.once('close', cleanup);
  });
  scheduledConnectionCloses.set(res, pending);
  // Discard bytes without constructing a parsed body. The grace period bounds
  // this work and ensures a valid error response can reach ordinary clients.
  req.resume();
  return pending;
}

function forwardBodyParserError(req: Request, res: Response, next: NextFunction, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if ((error as { closeConnection?: unknown }).closeConnection === true) {
    sendRejectedBodyResponse(req, res, () => next(error));
  } else next(error);
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
  readonly #waiting: WaitingBody[] = [];
  readonly #maxQueued: number;
  readonly #waitMs: number;
  readonly #now: () => number;
  #drainImmediate?: ReturnType<typeof setImmediate>;

  constructor(options: { maxQueuedRequests?: number; waitMs?: number; now?: () => number } = {}) {
    this.#maxQueued = options.maxQueuedRequests ?? MAX_QUEUED_HTTP_BODIES;
    this.#waitMs = options.waitMs ?? HTTP_BODY_ADMISSION_WAIT_MS;
    this.#now = options.now ?? (() => performance.now());
    if (
      !Number.isSafeInteger(this.#maxQueued) ||
      this.#maxQueued < 0 ||
      !Number.isSafeInteger(this.#waitMs) ||
      this.#waitMs < 1 ||
      this.#waitMs > 2_147_483_647
    ) {
      throw new Error('Invalid HTTP body admission queue limits.');
    }
  }

  getSnapshot(): HttpBodyAdmissionSnapshot {
    return Object.freeze({
      activeParsers: this.#activeParsers,
      maxActiveParsers: MAX_CONCURRENT_HTTP_BODY_PARSERS,
      maxReservedBytes: MAX_RESERVED_HTTP_BODY_BYTES,
      reservedBytes: this.#reservedBytes,
      retainedBodies: this.#retainedBodies,
      queuedRequests: this.#waiting.length,
      maxQueuedRequests: this.#maxQueued,
    });
  }

  admit(
    req: Request,
    limitBytes: number,
    options: { signal?: AbortSignal; receiveDeadline?: number } = {},
  ): BodyReservation | Promise<BodyReservation> {
    options.signal?.throwIfAborted();
    const contentLength = readContentLength(req);
    // Reject declared identity size before reading; the bounded transport
    // reader enforces the decoded limit for compressed content.
    if (!hasNonIdentityContentEncoding(req) && contentLength != null && contentLength > limitBytes) {
      throw createHttpError(413, "Request body exceeds this route's allowed size.", {
        expose: true,
        code: 'body_too_large',
        closeConnection: true,
      });
    }

    const reservationBytes = reservationBytesForRequest(req, limitBytes);
    if (options.receiveDeadline !== undefined && this.#now() >= options.receiveDeadline) {
      throw bodyReceiveTimeoutError();
    }
    if (!this.#fits(reservationBytes)) throw bodyCapacityError();
    if (this.#activeParsers < MAX_CONCURRENT_HTTP_BODY_PARSERS && this.#waiting.length === 0) {
      return this.#reserve(reservationBytes);
    }
    if (this.#waiting.length >= this.#maxQueued) throw bodyCapacityError();

    const startedAt = this.#now();
    let resolve!: WaitingBody['resolve'];
    let reject!: WaitingBody['reject'];
    const promise = new Promise<BodyReservation>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const entry: WaitingBody = {
      bytes: reservationBytes,
      startedAt,
      deadline: startedAt + this.#waitMs,
      receiveDeadline: options.receiveDeadline,
      signal: options.signal,
      resolve,
      reject,
      abort: () => this.#abortWait(entry),
    };
    this.#waiting.push(entry);
    options.signal?.addEventListener('abort', entry.abort, { once: true });
    this.#armTimeout(entry);
    // A new arrival may follow a released slot whose drain is already scheduled.
    this.#scheduleDrain();
    if (options.signal?.aborted) entry.abort();
    return promise;
  }

  #fits(bytes: number): boolean {
    return bytes <= MAX_RESERVED_HTTP_BODY_BYTES && this.#reservedBytes + bytes <= MAX_RESERVED_HTTP_BODY_BYTES;
  }

  #scheduleDrain(): void {
    if (this.#waiting.length === 0 || this.#drainImmediate) return;
    this.#drainImmediate = setImmediate(() => {
      this.#drainImmediate = undefined;
      while (this.#waiting.length) {
        const entry = this.#waiting[0]!;
        if (this.#expire(entry)) continue;
        if (this.#activeParsers >= MAX_CONCURRENT_HTTP_BODY_PARSERS) break;
        if (!this.#fits(entry.bytes)) {
          this.#reject(entry, bodyCapacityError(), 'capacity_exceeded');
          continue;
        }
        this.#remove(entry, 'admitted');
        entry.resolve(this.#reserve(entry.bytes));
      }
    });
  }

  #armTimeout(entry: WaitingBody): void {
    const deadline = Math.min(entry.deadline, entry.receiveDeadline ?? Infinity);
    entry.timer = setTimeout(
      () => {
        if (!this.#expire(entry)) this.#armTimeout(entry);
      },
      Math.max(1, Math.ceil(deadline - this.#now())),
    );
    entry.timer.unref();
  }

  #expire(entry: WaitingBody): boolean {
    if (!this.#waiting.includes(entry)) return true;
    if (entry.signal?.aborted) {
      this.#abortWait(entry);
      return true;
    }
    const now = this.#now();
    const receiveDeadline = entry.receiveDeadline ?? Infinity;
    // Preserve the first expiry even if event-loop work delays both timers.
    if (now >= entry.deadline && entry.deadline < receiveDeadline) {
      this.#reject(entry, bodyCapacityError(), 'wait_expired');
      return true;
    }
    if (now >= receiveDeadline) {
      this.#reject(entry, bodyReceiveTimeoutError(), 'receive_timeout');
      return true;
    }
    return false;
  }

  #abortWait(entry: WaitingBody): void {
    const reason: unknown = entry.signal?.reason ?? bodyAbortedError();
    const receiveTimeout =
      typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === 'body_receive_timeout';
    if (receiveTimeout && entry.deadline < (entry.receiveDeadline ?? Infinity) && this.#now() >= entry.deadline) {
      this.#reject(entry, bodyCapacityError(), 'wait_expired');
      return;
    }
    this.#reject(entry, reason, receiveTimeout ? 'receive_timeout' : 'cancelled');
  }

  #remove(entry: WaitingBody, outcome: MetricsHttpBodyWaitOutcome): boolean {
    const index = this.#waiting.indexOf(entry);
    if (index < 0) return false;
    this.#waiting.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    recordStudioMetrics((metrics) =>
      metrics.observeHttpBodyAdmissionWait(Math.max(0, this.#now() - entry.startedAt), outcome),
    );
    if (this.#waiting.length === 0 && this.#drainImmediate) {
      clearImmediate(this.#drainImmediate);
      this.#drainImmediate = undefined;
    }
    return true;
  }

  #reject(entry: WaitingBody, error: unknown, outcome: MetricsHttpBodyWaitOutcome): void {
    if (!this.#remove(entry, outcome)) return;
    entry.reject(error);
    this.#scheduleDrain();
  }

  #reserve(initialBytes: number): BodyReservation {
    let reservationBytes = initialBytes;

    this.#activeParsers += 1;
    this.#reservedBytes += reservationBytes;
    let parserSlotReleased = false;
    let released = false;
    let retained = false;
    let finalizedBytes: number | undefined;

    const releaseParserSlot = () => {
      if (parserSlotReleased) {
        return;
      }
      parserSlotReleased = true;
      this.#activeParsers = Math.max(0, this.#activeParsers - 1);
      this.#scheduleDrain();
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
      finalizeDecodedBytes: (bytes) => {
        if (released) return;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > reservationBytes) {
          throw new Error('Invalid decoded request-body size.');
        }
        if (finalizedBytes !== undefined && bytes !== finalizedBytes) {
          throw new Error('Decoded request-body size was already finalized.');
        }
        finalizedBytes = bytes;
        this.#reservedBytes -= reservationBytes - bytes;
        reservationBytes = bytes;
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
    markBodyReceived: (decodedBytes?: number) => void,
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
        forwardBodyParserError(
          req,
          res,
          next,
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

    if (res.destroyed || res.writableEnded) return;
    const limitBytes = options.getLimitBytes(req);
    const receiveTimeoutMs = options.receiveTimeoutMs ?? DEFAULT_HTTP_BODY_RECEIVE_TIMEOUT_MS;
    const receiveDeadline = performance.now() + receiveTimeoutMs;
    let reservation: BodyReservation | undefined;
    let parsingStarted = false;
    let parsingSettled = false;
    const cancellation = new AbortController();
    const releaseIfNotRetained = () => {
      if (parsingSettled && reservation && !reservation.isRetained()) {
        reservation.release();
      }
    };
    res.once('finish', releaseIfNotRetained);
    res.once('close', releaseIfNotRetained);

    let bodyReceived = false;
    let decodedBytes: number | undefined;
    let sizeReportError: Error | undefined;
    const receiveTimeout = setTimeout(() => {
      cancellation.abort(bodyReceiveTimeoutError());
    }, receiveTimeoutMs);
    receiveTimeout.unref();

    const markBodyReceived = (bytes?: number) => {
      if (parsingSettled) return;
      if (bytes !== undefined) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || (decodedBytes !== undefined && bytes !== decodedBytes)) {
          sizeReportError = new Error('Invalid decoded request-body size report.');
          cancellation.abort(sizeReportError);
        } else decodedBytes = bytes;
      }
      if (bodyReceived) return;
      bodyReceived = true;
      clearTimeout(receiveTimeout);
    };

    const settle = (error?: unknown) => {
      if (parsingSettled) {
        return;
      }
      if (!error) error = sizeReportError;
      if (!error && decodedBytes !== undefined) {
        try {
          reservation!.finalizeDecodedBytes(decodedBytes);
        } catch (sizeError) {
          error = sizeError;
        }
      }
      parsingSettled = true;
      clearTimeout(receiveTimeout);
      req.off('aborted', abortParsing);
      res.off('close', abortParsing);
      res.off('finish', abortParsing);
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
        reservation?.release();
        res.off('finish', releaseIfNotRetained);
        res.off('close', releaseIfNotRetained);
        forwardBodyParserError(req, res, next, error);
        return;
      }
      // Parsing has finished. Long-running handlers can retain only their
      // body's byte reservation; they must not consume one of the four
      // expensive parsing slots for the lifetime of graph execution.
      reservation!.releaseParserSlot();
      next();
    };

    const abortParsing = () => {
      cancellation.abort(bodyAbortedError());
      // Waiting owns no decoder. Remove all middleware state immediately;
      // a grant already queued as a promise reaction will release itself below.
      if (!parsingStarted) settle(cancellation.signal.reason);
    };
    req.once('aborted', abortParsing);
    res.once('close', abortParsing);
    res.once('finish', abortParsing);
    if (req.destroyed || req.aborted) {
      abortParsing();
      return;
    }

    const startParsing = (admitted: BodyReservation) => {
      if (parsingSettled || cancellation.signal.aborted || res.destroyed || res.writableEnded) {
        admitted.release();
        if (!parsingSettled) settle(cancellation.signal.reason ?? bodyAbortedError());
        return;
      }
      reservation = admitted;
      if (performance.now() >= receiveDeadline) {
        settle(bodyReceiveTimeoutError());
        return;
      }
      requestReservations.set(req, reservation);
      parsingStarted = true;
      try {
        options.parse(req, res, settle, limitBytes, cancellation.signal, markBodyReceived);
      } catch (error) {
        settle(error);
      }
    };
    try {
      const admitted = controller.admit(req, limitBytes, { signal: cancellation.signal, receiveDeadline });
      if (admitted instanceof Promise) {
        req.pause();
        // Attach here, in this request's settings/async context. The controller
        // only resolves promises; another request must never run our parser.
        void admitted.then(startParsing, settle);
      } else startParsing(admitted);
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
