import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { migrateManagedWorkflowSchema } from '../../routes/workflows/managed/schema-migrations.js';
import { startAsyncWorkflowProcess } from './workflow-async-process.js';
import type { seedHostedSubgraphFixture } from './hosted-subgraph-fixture.js';
import { runtimeTestRepo } from './runtime-test-entry.js';

/** No ambient service URLs, database, bucket, credentials or production data. */
export async function startHostedSubgraphRuntime(topology: 'single-host' | 'replicated' = 'single-host') {
  const owned: string[] = [];
  const ownedVolumes = new Set<string>();
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();
  let api: Awaited<ReturnType<typeof startAsyncWorkflowProcess>> | undefined;
  let executor: ReturnType<typeof spawn> | undefined;
  let proxy: http.Server | undefined;
  let pool: Pool | undefined;
  let s3: S3Client | undefined;
  const sockets = new Set<net.Socket>();
  let logs = '';
  const close = async () => {
    const errors: unknown[] = [];
    const attempt = async (cleanup: () => unknown | Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const socket of sockets) socket.destroy();
    if (proxy?.listening) await attempt(() => new Promise<void>((resolve) => proxy!.close(() => resolve())));
    if (executor && executor.exitCode === null && executor.signalCode === null) {
      const exited = once(executor, 'exit');
      const deadline = setTimeout(() => executor!.kill('SIGKILL'), 10_000);
      executor.kill();
      try {
        await attempt(() => exited);
      } finally {
        clearTimeout(deadline);
      }
    }
    await attempt(() => api?.close());
    await attempt(() => pool?.end());
    s3?.destroy();
    // These containers have no host/named mounts. Remove their image-created
    // anonymous volumes too; otherwise every browser run leaks a PostgreSQL disk.
    for (const id of owned.reverse()) await attempt(() => docker('rm', '-fv', id));
    if (ownedVolumes.size) {
      await attempt(() => {
        const remaining = new Set(docker('volume', 'ls', '--format', '{{.Name}}').split(/\r?\n/));
        for (const volume of ownedVolumes) assert.ok(!remaining.has(volume), `Test volume was not removed: ${volume}`);
      });
    }
    if (errors.length) throw new AggregateError(errors, 'Hosted Subgraph fixture cleanup failed');
  };
  try {
    const launch = (port: number, ...args: string[]) => {
      const id = docker(
        'run',
        '-d',
        '--name',
        `rivet-hosted-subgraph-${randomUUID()}`,
        '-p',
        `127.0.0.1::${port}`,
        ...args,
      );
      owned.push(id);
      const mounts = JSON.parse(docker('inspect', '--format', '{{json .Mounts}}', id)) as Array<{
        Type: string;
        Name?: string;
      }>;
      for (const mount of mounts) if (mount.Type === 'volume' && mount.Name) ownedVolumes.add(mount.Name);
      return Number(
        docker('inspect', '--format', `{{(index (index .NetworkSettings.Ports "${port}/tcp") 0).HostPort}}`, id),
      );
    };
    const dbPort = launch(
      5432,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e',
      'POSTGRES_DB=subgraph',
      'postgres:16.8-alpine',
    );
    const s3Port = launch(
      9000,
      '-e',
      'MINIO_ROOT_USER=subgraphfixture',
      '-e',
      'MINIO_ROOT_PASSWORD=subgraphfixturesecret',
      'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
      'server',
      '/tmp/minio',
    );
    const connectionString = `postgres://postgres@127.0.0.1:${dbPort}/subgraph`;
    pool = new Pool({ connectionString, connectionTimeoutMillis: 1_000 });
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        await pool.query('SELECT 1');
        assert.equal(
          (await fetch(`http://127.0.0.1:${s3Port}/minio/health/ready`, { signal: AbortSignal.timeout(1000) })).status,
          200,
        );
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(100);
      }
    }
    await migrateManagedWorkflowSchema(pool);
    s3 = new S3Client({
      endpoint: `http://127.0.0.1:${s3Port}`,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'subgraphfixture', secretAccessKey: 'subgraphfixturesecret' },
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'subgraph-fixture' }));
    api = await startAsyncWorkflowProcess({
      requireUiAuth: true,
      storage: {
        version: 1,
        storageMode: 'managed',
        databaseMode: 'managed',
        databaseSslMode: 'disable',
        databaseConnectionString: connectionString,
        storageUrl: `http://127.0.0.1:${s3Port}/subgraph-fixture`,
        objectStorageBucket: 'subgraph-fixture',
        objectStorageEndpoint: `http://127.0.0.1:${s3Port}`,
        objectStorageRegion: 'us-east-1',
        objectStoragePrefix: 'fixture/',
        objectStorageForcePathStyle: true,
        storageAccessKeyId: 'subgraphfixture',
        storageAccessKey: 'subgraphfixturesecret',
      },
    });
    const fixture = await api.command<Awaited<ReturnType<typeof seedHostedSubgraphFixture>>>('seed-hosted-subgraph');
    const token = (scope: string) => createHash('sha256').update(`async-fixture-key:${scope}`).digest('hex');
    const proxyToken = token('proxy-auth');
    const serviceHeaders = { 'x-rivet-proxy-auth': proxyToken, 'x-rivet-executor-auth': token('executor-internal') };
    const operatorHeaders = { 'x-rivet-proxy-auth': proxyToken, cookie: `rivet_ui_token=${token('ui-session')}` };
    const requests: Array<{ path: string; status: number; service: boolean; cookie: boolean }> = [];
    let moveOnNextAccess = false;
    proxy = http.createServer(async (req, res) => {
      try {
        if (moveOnNextAccess && req.url?.includes('/access?')) {
          moveOnNextAccess = false;
          await api!.command('move-hosted-subgraph');
        }
        const upstream = http.request(
          new URL(req.url!, api!.baseUrl),
          {
            method: req.method,
            // Preserve the executor's actual credentials. Browser requests add
            // proxy auth at their own test edge; repairing it here hides bugs.
            headers: req.headers,
          },
          (response) => {
            requests.push({
              path: req.url!,
              status: response.statusCode!,
              service: req.headers['x-rivet-executor-auth'] === serviceHeaders['x-rivet-executor-auth'],
              cookie: Boolean(req.headers.cookie),
            });
            res.writeHead(response.statusCode!, response.headers);
            response.pipe(res);
          },
        );
        upstream.on('error', () => res.destroy());
        req.pipe(upstream);
      } catch {
        res.writeHead(500).end();
      }
    });
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
    const reservation = net.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const executorPort = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_')));
    executor = spawn(
      process.execPath,
      [
        path.join(runtimeTestRepo, 'packages/studio-server-executor/dist/executor-bundle.cjs'),
        '--host',
        '127.0.0.1',
        '--port',
        String(executorPort),
      ],
      {
        env: {
          ...env,
          RIVET_KEY: 'async-fixture-key',
          ...(topology === 'replicated'
            ? {
                RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
                RIVET_EXECUTOR_RUNTIME_CONFIG_URL: `${baseUrl}/internal/executor-runtime-config`,
                RIVET_HA_PROTOCOL: '1',
              }
            : {
                RIVET_EXECUTION_ENVIRONMENT_API_URL: `${baseUrl}/api/workflows/execution-environment`,
                RIVET_LLM_PROFILE_HEALTH_API_URL: `${baseUrl}/api/workflows/llm-profile-health`,
              }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    executor.stdout!.on('data', (chunk) => {
      logs += chunk;
    });
    executor.stderr!.on('data', (chunk) => {
      logs += chunk;
    });
    executor.on('error', (error) => {
      logs += error;
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(executorPort, '127.0.0.1');
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', reject);
        });
        break;
      } catch {
        if (attempt > 300 || executor.exitCode !== null) throw new Error(`Hosted executor startup failed: ${logs}`);
        await delay(100);
      }
    }
    proxy.on('upgrade', (req, socket, head) => {
      const upstream = http.request({
        hostname: '127.0.0.1',
        port: executorPort,
        path: req.url,
        headers: { ...req.headers, 'x-rivet-proxy-auth': proxyToken },
      });
      upstream.on('upgrade', (response, target, targetHead) => {
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join('')}\r\n`,
        );
        if (targetHead.length) socket.write(targetHead);
        if (head.length) target.write(head);
        socket.pipe(target).pipe(socket);
        socket.on('error', () => target.destroy());
        target.on('error', () => socket.destroy());
        socket.on('close', () => target.destroy());
      });
      upstream.on('response', (response) => {
        socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`);
        response.resume();
      });
      upstream.on('error', () => socket.destroy());
      upstream.end();
    });
    return {
      baseUrl,
      executorWsUrl:
        baseUrl.replace('http:', 'ws:') +
        (topology === 'replicated' ? '/ws/executor/owner/subgraph-fixture' : '/ws/executor/internal'),
      fixture,
      serviceHeaders,
      operatorHeaders,
      requests,
      cookie: { name: 'rivet_ui_token', value: token('ui-session'), domain: '127.0.0.1', path: '/' },
      moveOnNextAccess() {
        moveOnNextAccess = true;
      },
      get logs() {
        return logs + api!.logs;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
