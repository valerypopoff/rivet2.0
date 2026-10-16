import type { Request, Response } from 'express';
import type { JobStatus, RuntimeLibraryJobState } from '../../../studio-server-shared/runtime-library-types.js';
import { pollRuntimeLibraryJob, type RuntimeLibraryJobObserver } from '../runtime-libraries/job-observation.js';
import { watchVmMigrationPassiveStream } from '../vm-migration-maintenance.js';

/** HTTP owns framing, disconnects and backpressure; subscriptions never cancel jobs. */
export async function streamRuntimeLibraryJob(
  req: Request,
  res: Response,
  source: {
    getJob(jobId: string): Promise<RuntimeLibraryJobState | null>;
    subscribeJob?(jobId: string, observer: RuntimeLibraryJobObserver): () => void;
  },
): Promise<void> {
  let previousStatus: JobStatus | null = null,
    lastSeq = 0,
    closed = false,
    streaming = false;
  let keepalive: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let buffered: RuntimeLibraryJobState | null | undefined;
  let observationError: unknown;
  let observationFailed = false;
  let latestJob: RuntimeLibraryJobState | null = null;
  let blocked = false;
  let terminalSent = false;
  let stallTimer: NodeJS.Timeout | undefined;
  const unavailable = () => closed || res.destroyed || res.writableEnded;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    clearTimeout(stallTimer);
    const stopObservation = unsubscribe;
    unsubscribe = undefined;
    stopObservation?.();
    latestJob = null;
    buffered = undefined;
    req.off('close', cleanup);
    res.off('close', cleanup);
    res.off('finish', cleanup);
    res.off('drain', onDrain);
  };
  const end = () => {
    cleanup();
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  res.once('finish', cleanup);
  const writeRaw = (chunk: string) => {
    // A false result still accepted this chunk. Resume at the next cursor only
    // after drain; retain one latest state, not a queue of serialized log events.
    if (res.write(chunk)) return true;
    blocked = true;
    res.once('drain', onDrain);
    stallTimer = setTimeout(() => {
      cleanup();
      res.destroy();
    }, 30_000);
    stallTimer.unref();
    return false;
  };
  const write = (data: unknown) => writeRaw(`data: ${JSON.stringify(data)}\n\n`);
  const flush = () => {
    if (unavailable() || blocked) return;
    if (terminalSent) {
      end();
      return;
    }
    const job = latestJob;
    if (!job) {
      end();
      return;
    }
    // Native subscriptions emit on every append; do not rescan retained history.
    for (let index = lastSeq; index < job.logEntries.length; index++) {
      const entry = job.logEntries[index]!;
      lastSeq = index + 1;
      if (!write({ type: 'log', ...entry })) return;
    }
    if (job.status !== previousStatus) {
      previousStatus = job.status;
      if (
        !write({
          type: 'status',
          status: job.status,
          createdAt: job.lastProgressAt,
          cancelRequestedAt: job.cancelRequestedAt ?? null,
        })
      )
        return;
    }
    if (job.status === 'succeeded' || job.status === 'failed') {
      terminalSent = true;
      if (
        !write({
          type: 'done',
          status: job.status,
          error: job.error,
          createdAt: job.lastProgressAt,
          cancelRequestedAt: job.cancelRequestedAt ?? null,
        })
      )
        return;
      end();
    }
  };
  function onDrain() {
    clearTimeout(stallTimer);
    stallTimer = undefined;
    blocked = false;
    flush();
  }
  const sendState = (job: RuntimeLibraryJobState | null) => {
    latestJob = job;
    flush();
  };
  try {
    const initial = await source.getJob(req.params.jobId);
    if (unavailable()) {
      cleanup();
      return;
    }
    if (!initial) {
      cleanup();
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const observer: RuntimeLibraryJobObserver = {
      state(job) {
        if (unavailable()) return;
        if (streaming) sendState(job);
        else buffered = job;
      },
      error(error) {
        if (unavailable()) return;
        if (streaming) end();
        else {
          observationError = error;
          observationFailed = true;
        }
      },
    };
    unsubscribe = source.subscribeJob
      ? source.subscribeJob(req.params.jobId, observer)
      : pollRuntimeLibraryJob(req.params.jobId, (id) => source.getJob(id), observer);
    // Close the read/subscribe gap without coupling the durable job to HTTP.
    buffered = undefined;
    const current = source.subscribeJob ? await source.getJob(req.params.jobId) : initial;
    if (unavailable()) {
      const stopObservation = unsubscribe;
      unsubscribe = undefined;
      stopObservation?.();
      return;
    }
    if (observationFailed) throw observationError;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (!watchVmMigrationPassiveStream(res)) { cleanup(); return; }
    streaming = true;
    const firstState = buffered !== undefined ? buffered : current;
    buffered = undefined;
    sendState(firstState);
    if (closed) return;
    keepalive = setInterval(() => {
      if (unavailable()) end();
      else if (!blocked) writeRaw(':keepalive\n\n');
    }, 30_000);
    keepalive.unref();
  } catch (error) {
    cleanup();
    throw error;
  }
}
