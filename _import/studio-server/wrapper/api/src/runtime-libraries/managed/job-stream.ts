import type { Request, Response } from 'express';

import type { JobStatus, RuntimeLibraryJobState } from '../../../../shared/runtime-library-types.js';

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

  const sendState = async () => {
    const job = await options.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return false;
    }

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

  const initialJob = await options.getJob(req.params.jobId);
  if (!initialJob) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  lastSeq = initialJob.logEntries.length;
  for (const entry of initialJob.logEntries) {
    res.write(`data: ${JSON.stringify({ type: 'log', message: entry.message, createdAt: entry.createdAt, source: entry.source })}\n\n`);
  }
  previousStatus = initialJob.status;
  res.write(`data: ${JSON.stringify({ type: 'status', status: initialJob.status, createdAt: initialJob.lastProgressAt, cancelRequestedAt: initialJob.cancelRequestedAt ?? null })}\n\n`);

  if (initialJob.status === 'succeeded' || initialJob.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'done', status: initialJob.status, error: initialJob.error, createdAt: initialJob.lastProgressAt, cancelRequestedAt: initialJob.cancelRequestedAt ?? null })}\n\n`);
    res.end();
    return;
  }

  const interval = setInterval(() => {
    if (closed) {
      return;
    }

    void sendState()
      .then((keepOpen) => {
        if (!keepOpen && !closed) {
          cleanup();
          res.end();
        }
      })
      .catch((error) => {
        console.error('[runtime-libraries] Failed to poll managed job stream:', error);
        cleanup();
        res.end();
      });
  }, 1_000);

  const keepalive = setInterval(() => {
    if (!closed) {
      res.write(':keepalive\n\n');
    }
  }, 30_000);

  const cleanup = () => {
    closed = true;
    clearInterval(interval);
    clearInterval(keepalive);
  };

  req.on('close', cleanup);
}
