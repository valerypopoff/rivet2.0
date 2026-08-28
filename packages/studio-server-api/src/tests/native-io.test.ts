import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const nativeIo = await import('../routes/native-io.js');
const nativeRoutes = await import('../routes/native.js');

async function withNativeApiServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/native', nativeRoutes.nativeRouter);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server address');
  }

  try {
    await run(`http://127.0.0.1:${address.port}/native`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('native path resolution rejects unsupported baseDir values', () => {
  assert.throws(
    () => nativeIo.resolveNativePath('example.txt', 'workspace' as never),
    /Path not allowed|Invalid/,
  );
});

test('native path exists preserves validation errors for disallowed paths', async () => {
  const outsideAllowedRoot = path.resolve(path.parse(process.cwd()).root, 'outside-allowed-root');

  await assert.rejects(
    nativeIo.nativePathExists(outsideAllowedRoot),
    /Path not allowed/,
  );
});

test('native exists route rejects unsupported baseDir values', async () => {
  await withNativeApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/exists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'file.txt',
        baseDir: 'workspace',
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? '', /Invalid option|baseDir/i);
  });
});

test('native readDir filters apply globs before ignores', () => {
  const results = nativeIo.applyReadDirFilters(
    [
      '/managed/workflows/Alpha.rivet-project',
      '/managed/workflows/Alpha.rivet-data',
      '/managed/workflows/nested/Beta.rivet-project',
      '/managed/workflows/nested/Gamma.rivet-project',
    ],
    {
      filterGlobs: ['**/*.rivet-project'],
      ignores: ['**/nested/**'],
    },
  );

  assert.deepEqual(results, ['/managed/workflows/Alpha.rivet-project']);
});

test('native readDir filters preserve entries when no filters are provided', () => {
  const entries = [
    '/managed/workflows/Alpha.rivet-project',
    '/managed/workflows/Beta.rivet-project',
  ];

  assert.deepEqual(
    nativeIo.applyReadDirFilters(entries, {
      filterGlobs: [],
      ignores: [],
    }),
    entries,
  );
});
