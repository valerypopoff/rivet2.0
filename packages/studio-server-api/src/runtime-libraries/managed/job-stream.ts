import type { Request, Response } from 'express';

import type { JobStatus, RuntimeLibraryJobState } from '../../../../studio-server-shared/runtime-library-types.js';

export async function streamManagedRuntimeLibraryJob(
  req: Request,
  res: Response,
  options: {
    getJob(jobId: string): Promise<RuntimeLibraryJobState | null>;
  },
): Promise<void> {
  let previousStatus: JobStatus | null = null;
  let lastSeq = 0;
  let closed = false;
  let polling = false;
  let interval: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;

  const cleanup = () => {
    closed = true;
    clearInterval(interval);
    clearInterval(keepalive);
    req.off('close', cleanup);
    res.off('close', cleanup);
    res.off('finish', cleanup);
  };
  const unavailable = () => closed || res.destroyed || res.writableEnded;
  req.once('close', cleanup);
  res.once('close', cleanup);
  res.once('finish', cleanup);

  const sendState = (job: RuntimeLibraryJobState) => {
    for (const [index, entry] of job.logEntries.entries()) {
      const seq = index + 1;
      if (seq <= lastSeq) {
        continue;
      }

      lastSeq = seq;
      res.write(`data: ${JSON.stringify({ type: 'log', message: entry.message, createdAt: entry.createdAt, source: entry.source })}\n\n`);
    }

    if (job.status !== previousStatus) {
      previousStatus = job.status;
      res.write(`data: ${JSON.stringify({ type: 'status', status: job.status, createdAt: job.lastProgressAt, cancelRequestedAt: job.cancelRequestedAt ?? null })}\n\n`);
    }

    if (job.status === 'succeeded' || job.status === 'failed') {
      res.write(`data: ${JSON.stringify({ type: 'done', status: job.status, error: job.error, createdAt: job.lastProgressAt, cancelRequestedAt: job.cancelRequestedAt ?? null })}\n\n`);
      return false;
    }

    return true;
  };

  let initialJob: RuntimeLibraryJobState | null;
  try {
    initialJob = await options.getJob(req.params.jobId);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (unavailable()) { cleanup(); return; }
  if (!initialJob) {
    cleanup();
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!sendState(initialJob)) {
    cleanup();
    res.end();
    return;
  }

  interval = setInterval(() => {
    if (unavailable()) { cleanup(); return; }
    if (polling) return;
    polling = true;
    void options.getJob(req.params.jobId)
      .then((job) => {
        // Access can be revoked while a storage lookup is pending.
        if (unavailable()) return;
        if (!job || !sendState(job)) {
          cleanup();
          res.end();
        }
      })
      .catch((error) => {
        if (unavailable()) return;
        console.error('[runtime-libraries] Failed to poll managed job stream:', error);
        cleanup();
        res.end();
      })
      .finally(() => { polling = false; });
  }, 1_000);

  keepalive = setInterval(() => {
    if (!unavailable()) {
      res.write(':keepalive\n\n');
    }
  }, 30_000);

  interval.unref();
  keepalive.unref();
}
