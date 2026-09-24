import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import type { ManagedRuntimeLibrariesConfig } from '../runtime-libraries/config.js';
import {
  deleteRuntimeLibrariesBlobObjects,
  listRuntimeLibrariesBlobObjects,
  S3RuntimeLibrariesBlobStore,
} from '../runtime-libraries/managed/blob-store.js';
import { S3ManagedWorkflowBlobStore } from '../routes/workflows/managed/blob-store.js';
import { listenTestServer } from './helpers/http-server-harness.js';

function createConfig(endpoint: string): ManagedRuntimeLibrariesConfig {
  return {
    databaseMode: 'managed',
    databaseUrl: 'postgresql://rivet@example.test/rivet',
    databaseSslMode: 'require',
    objectStorageBucket: 'rivet',
    objectStorageRegion: 'us-east-1',
    objectStorageEndpoint: endpoint,
    objectStorageAccessKeyId: 'access',
    objectStorageSecretAccessKey: 'secret',
    objectStoragePrefix: 'runtime-libraries/',
    objectStorageForcePathStyle: true,
    syncPollIntervalMs: 5_000,
    runtimeProcessRole: 'api',
    runtimeReplicaTier: 'endpoint',
    replicaStatusRetentionMs: 60_000,
    replicaStatusCleanupIntervalMs: 60_000,
    jobWorkerEnabled: true,
  };
}

test('managed blob stores accept a bucket created by another process after their first HEAD', async () => {
  let headRequests = 0;
  let createRequests = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      if (request.method === 'HEAD') {
        response.writeHead(++headRequests === 1 ? 404 : 200);
        response.end();
      } else if (request.method === 'PUT') {
        createRequests += 1;
        response.writeHead(409, { 'content-type': 'application/xml' });
        response.end('<Error><Code>BucketAlreadyOwnedByYou</Code></Error>');
      } else {
        response.writeHead(500);
        response.end();
      }
    });
  });
  const listener = await listenTestServer(server);

  try {
    for (const makeStore of [
      () => new S3ManagedWorkflowBlobStore(createConfig(listener.baseUrl)),
      () => new S3RuntimeLibrariesBlobStore(createConfig(listener.baseUrl)),
    ]) {
      headRequests = 0;
      createRequests = 0;
      const store = makeStore();
      try {
        await store.initialize();
        assert.equal(headRequests, 2);
        assert.equal(createRequests, 1);
      } finally {
        store.dispose();
      }
    }
  } finally {
    await listener.close();
  }
});

test('managed runtime-library deletion fails visibly when S3 partially rejects a batch', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          '<Error><Key>runtime-libraries/releases/rejected/release.tar</Key>' +
          '<Code>AccessDenied</Code><Message>denied</Message></Error>' +
          '</DeleteResult>',
      );
    });
  });
  const listener = await listenTestServer(server);

  try {
    await assert.rejects(
      deleteRuntimeLibrariesBlobObjects(createConfig(listener.baseUrl), [
        'releases/rejected/release.tar',
      ]),
      /releases\/rejected\/release\.tar \(AccessDenied\)/,
    );
  } finally {
    await listener.close();
  }
});

test('managed runtime-library audit rejects a truncated S3 listing without a continuation token', async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?>' +
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          '<IsTruncated>true</IsTruncated>' +
          '<Contents><Key>runtime-libraries/releases/incomplete/release.tar</Key><Size>1</Size></Contents>' +
          '</ListBucketResult>',
      );
    });
  });
  const listener = await listenTestServer(server);

  try {
    await assert.rejects(
      listRuntimeLibrariesBlobObjects(createConfig(listener.baseUrl)),
      /truncated without a continuation token/,
    );
  } finally {
    await listener.close();
  }
});

test('managed runtime-library audit rejects a repeated S3 continuation token', async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    response.writeHead(200, { 'content-type': 'application/xml' });
    response.end(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        '<IsTruncated>true</IsTruncated><NextContinuationToken>same-token</NextContinuationToken>' +
        '</ListBucketResult>',
    );
  });
  const listener = await listenTestServer(server);

  try {
    await assert.rejects(
      listRuntimeLibrariesBlobObjects(createConfig(listener.baseUrl)),
      /same continuation token more than once/,
    );
  } finally {
    await listener.close();
  }
});
