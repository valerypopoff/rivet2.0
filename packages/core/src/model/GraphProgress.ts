export type GraphProgress = Readonly<{
  message?: string;
  percent?: number;
}>;

const MAX_PROGRESS_MESSAGE_LENGTH = 500;

/** Normalizes public graph progress before it crosses executor or web-app transports. */
export function normalizeGraphProgress(progress: GraphProgress): GraphProgress | undefined {
  const message =
    typeof progress.message === 'string' ? progress.message.trim().slice(0, MAX_PROGRESS_MESSAGE_LENGTH) : '';
  const percent =
    typeof progress.percent === 'number' && Number.isFinite(progress.percent)
      ? Math.min(100, Math.max(0, progress.percent))
      : undefined;

  if (!message && percent == null) {
    return undefined;
  }

  return {
    ...(message ? { message } : {}),
    ...(percent == null ? {} : { percent }),
  };
}
