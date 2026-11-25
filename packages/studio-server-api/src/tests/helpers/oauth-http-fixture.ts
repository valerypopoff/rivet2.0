import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runtimeTestEntry, runtimeTestRepo } from './runtime-test-entry.js';

export type OAuthProviderRequest = {
  stage: 'token' | 'profile';
  method: string;
  authorization: string;
  accept: string;
  contentType: string;
  body: string;
};
export type OAuthRedirect = { location: string; cookies: string[] };
export type OAuthStatus = {
  uiEmail: string | null;
  uiAllowed: boolean;
  visitorEmail: string | null;
  visitorAllowed: boolean;
};

/** One disposable API/provider process, also used by the real-cookie browser journey. */
export async function startOAuthHttpFixture(mode = process.env.RIVET_API_TEST_RUNTIME || 'source') {
  const entry = runtimeTestEntry('tests/helpers/oauth-http-server.js', mode);
  const temporaryDirectory = await fs.realpath(os.tmpdir());
  const rootPrefix = `rivet-oauth-${process.pid}-`;
  const root = await fs.mkdtemp(path.join(temporaryDirectory, rootPrefix));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_') && !key.startsWith('OAUTH_')),
  );
  Object.assign(env, {
    RIVET_OAUTH_TEST_ROOT: root,
    RIVET_APP_DATA_ROOT: path.join(root, 'app'),
    RIVET_WORKSPACE_ROOT: root,
    RIVET_WORKFLOWS_ROOT: path.join(root, 'workflows'),
    RIVET_RUNTIME_LIBRARIES_ROOT: path.join(root, 'libraries'),
    RIVET_STORAGE_MODE: 'filesystem',
    RIVET_KEY: 'oauth-fixture-key',
    RIVET_SERVER_UI_AUTH_MODE: 'oauth',
    RIVET_ENABLE_DEVELOPMENT_AUTH: 'false',
    DOTENV_CONFIG_PATH: path.join(root, 'absent.env'),
    NODE_USE_ENV_PROXY: '0',
  });
  const child = spawn(process.execPath, entry, {
    cwd: path.join(runtimeTestRepo, 'packages/studio-server-api'),
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '',
    nextId = 0;
  let ready = false;
  child.stdout!.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    logs += chunk;
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => {
      for (const request of pending.values()) request.reject(new Error(`OAuth fixture exited\n${logs}`));
      pending.clear();
      resolve();
    });
  });
  child.on('message', (message: { id?: number; result?: unknown; error?: string }) => {
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  async function command<T = unknown>(name: string, value?: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`OAuth fixture command timed out: ${name}\n${logs}`));
      }, 15_000);
      pending.set(id, {
        resolve(result) {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      const fail = (error: Error | null) => {
        if (error) {
          const request = pending.get(id);
          pending.delete(id);
          request?.reject(error);
        }
      };
      try {
        child.send!({ id, command: name, value }, fail);
      } catch (error) {
        fail(error as Error);
      }
    });
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closing ??= (async () => {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
      let shutdownError: unknown;
      try {
        if (!ready) child.kill('SIGKILL');
        else if (child.connected && child.exitCode === null && child.signalCode === null) {
          try {
            await command('shutdown');
          } catch (error) {
            shutdownError = error;
          }
        } else shutdownError = new Error(`OAuth fixture exited without a shutdown acknowledgement\n${logs}`);
        await exited;
      } finally {
        clearTimeout(deadline);
      }
      if (path.dirname(root) !== temporaryDirectory || !path.basename(root).startsWith(rootPrefix))
        throw Error('Unexpected fixture root');
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      if (ready && (child.exitCode !== 0 || child.signalCode !== null))
        shutdownError ??= new Error(`OAuth fixture exited abnormally after shutdown\n${logs}`);
      if (shutdownError) throw shutdownError;
    })());
  }
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OAuth fixture startup timed out\n${logs}`)), 45_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('close', () => fail(new Error(`OAuth fixture startup exited\n${logs}`)));
      child.on('message', (message: { ready?: { baseUrl: string } }) => {
        if (message.ready) {
          clearTimeout(timer);
          resolve(message.ready.baseUrl);
        }
      });
    });
    ready = true;
    return { baseUrl, root, command, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'OAuth fixture startup and cleanup failed');
    }
    throw error;
  }
}

export function oauthCookie(header: string | string[], name: string): string {
  const values = typeof header === 'string' ? [header] : header;
  const value = values.map((cookie) => cookie.match(new RegExp(`(?:^|, )${name}=([^;]+)`))?.[1]).find(Boolean);
  if (!value) throw new Error(`Missing fixture cookie ${name}`);
  return `${name}=${value}`;
}

export function oauthCallback(
  baseUrl: string,
  surface: 'ui' | 'visitor',
  redirect: OAuthRedirect,
  email: string,
): string {
  const url = new URL(surface === 'ui' ? '/ui-auth/oauth/callback' : '/apps/auth/callback', baseUrl);
  url.searchParams.set('state', new URL(redirect.location).searchParams.get('state')!);
  url.searchParams.set('code', Buffer.from(email).toString('base64url'));
  return url.toString();
}
