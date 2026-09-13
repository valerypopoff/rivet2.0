import { Readable } from 'node:stream';
import { createGunzip, createInflate } from 'node:zlib';
import express, { type Request, type Response, type NextFunction } from 'express';

import { createHttpError } from '../utils/httpError.js';

/** Own transport consumption so parser errors never drain an unbounded upload. */
export function parseBoundedBody(
  req: Request,
  res: Response,
  next: NextFunction,
  limit: number,
  signal: AbortSignal,
  markBodyReceived: () => void,
): void {
  void receive().then(
    () => {
      markBodyReceived();
      next();
    },
    next,
  );

  async function receive(): Promise<void> {
    signal.throwIfAborted();
    // Authorization may have awaited storage after the client disconnected.
    // Those stream events will not be replayed to newly installed listeners.
    if (req.destroyed || req.aborted) {
      throw createHttpError(400, 'Request body was aborted.', { expose: true, closeConnection: true });
    }
    const encoding = (req.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (!['identity', 'gzip', 'deflate'].includes(encoding)) {
      throw createHttpError(415, 'Unsupported content encoding.', { expose: true, closeConnection: true });
    }
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : undefined;
    const source = decoder ?? req;
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        source.off('data', data);
        source.off('end', end);
        req.off('error', fail);
        signal.removeEventListener('abort', abort);
        req.pause();
        const done = () => {
          source.off('error', fail);
          if (error) {
            chunks.length = 0;
            reject(error);
          } else resolve();
        };
        if (decoder) {
          req.unpipe(decoder);
          decoder.once('close', done);
          decoder.destroy();
        } else done();
      };
      const fail = (error: Error) => finish(createHttpError(400, error.message, { expose: true, closeConnection: true }));
      const abort = () => finish(signal.reason);
      const end = () => finish();
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          finish(createHttpError(413, 'Request body is too large.', { expose: true, closeConnection: true }));
        } else chunks.push(chunk);
      };
      source.on('data', data);
      source.once('end', end);
      source.on('error', fail);
      if (decoder) req.once('error', fail);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (decoder) req.pipe(decoder);
    });
    signal.throwIfAborted();
    // Keep Express's JSON charset/primitive and form semantics, but give it a
    // finite decoded stream: its error-drain behavior cannot retain the socket.
    const input = Readable.from(chunks) as Request;
    input.headers = { ...req.headers, 'content-length': String(size) };
    delete input.headers['content-encoding'];
    delete input.headers['transfer-encoding'];
    const parser = req.is('application/x-www-form-urlencoded')
      ? express.urlencoded({ extended: false, limit })
      : express.json({ limit, strict: false, type: ['application/json', 'application/*+json'] });
    try {
      await new Promise<void>((resolve, reject) => parser(input, res, (error?: unknown) => error ? reject(error) : resolve()));
      signal.throwIfAborted();
      req.body = input.body;
    } finally {
      input.destroy();
      chunks.length = 0;
    }
  }
}
