import { serve as serveHono } from '@hono/node-server';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type * as yargs from 'yargs';

export type HttpCliOptions = {
  bearerToken?: string;
  corsOrigin?: string[];
};

export type HttpJsonError = {
  error: {
    message: string;
    name: string;
  };
  durationMs: number;
};

type CliJsonStatus = 400 | 401 | 404 | 409 | 500;

export class CliHttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'CliHttpError';
  }
}

export function addHttpOptions<T>(y: yargs.Argv<T>): yargs.Argv<T> {
  return y
    .option('bearer-token', {
      describe: 'Require Authorization: Bearer <token>. Defaults to RIVET_CLI_BEARER_TOKEN.',
      type: 'string',
    })
    .option('cors-origin', {
      describe: 'Allow a CORS origin. Can be repeated, or set to *.',
      type: 'string',
      array: true,
      default: [],
    });
}

export function createHttpMiddleware({ bearerToken, corsOrigin = [] }: HttpCliOptions): MiddlewareHandler {
  const effectiveBearerToken = bearerToken ?? process.env.RIVET_CLI_BEARER_TOKEN;

  return async (c, next) => {
    applyCorsHeaders(c, corsOrigin);

    if (c.req.method === 'OPTIONS' && corsOrigin.length > 0) {
      return c.body(null, 204);
    }

    if (c.req.path !== '/healthz' && effectiveBearerToken) {
      const authorization = c.req.header('authorization');

      if (authorization !== `Bearer ${effectiveBearerToken}`) {
        return c.json(
          {
            error: {
              message: 'Unauthorized.',
              name: 'Unauthorized',
            },
            durationMs: 0,
          } satisfies HttpJsonError,
          401,
        );
      }
    }

    await next();
    applyCorsHeaders(c, corsOrigin);
  };
}

export function jsonErrorResponse(c: Context, error: unknown, startedAt: number, fallbackStatus = 500): Response {
  const status = error instanceof CliHttpError ? error.status : fallbackStatus;
  const durationMs = Math.max(0, Date.now() - startedAt);
  c.header('x-duration-ms', String(durationMs));

  return c.json(
    {
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
      },
      durationMs,
    } satisfies HttpJsonError,
    toCliJsonStatus(status),
  );
}

export function jsonTimedResponse(c: Context, payload: unknown, startedAt: number): Response {
  c.header('x-duration-ms', String(Math.max(0, Date.now() - startedAt)));
  return c.json(payload as never);
}

export function formatListenUrl(host: string, port: number): string {
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${displayHost}:${port}`;
}

export function startHttpServer(app: Hono, host: string, port: number): void {
  const server = serveHono({
    fetch: app.fetch,
    hostname: host,
    port,
  });

  function shutdown() {
    console.log('Shutting down...');

    server.close((err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }

      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function applyCorsHeaders(c: Context, corsOrigins: string[]): void {
  if (corsOrigins.length === 0) {
    return;
  }

  const requestOrigin = c.req.header('origin');
  const allowedOrigin = resolveAllowedOrigin(corsOrigins, requestOrigin);

  if (!allowedOrigin) {
    return;
  }

  c.header('access-control-allow-origin', allowedOrigin);
  c.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  c.header('access-control-allow-headers', 'content-type,authorization');
  c.header('vary', 'Origin');
}

function resolveAllowedOrigin(corsOrigins: string[], requestOrigin: string | undefined): string | undefined {
  if (corsOrigins.includes('*')) {
    return '*';
  }

  return requestOrigin && corsOrigins.includes(requestOrigin) ? requestOrigin : undefined;
}

function toCliJsonStatus(status: number): CliJsonStatus {
  return status === 400 || status === 401 || status === 404 || status === 409 || status === 500 ? status : 500;
}
