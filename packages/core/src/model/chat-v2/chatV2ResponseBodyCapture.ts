/**
 * Captures provider HTTP response bodies for the opt-in LLM Chat diagnostic
 * output without consuming the Response that the AI SDK is still streaming.
 */
export type ChatV2ResponseBodyCapture = {
  /** Captured bodies in physical provider-response order. */
  readonly bodies: unknown[];
  /** Starts an independent clone read for one provider HTTP response. */
  capture(response: Response, redactionValues?: readonly string[]): void;
  /** Waits for every response observed so far to finish cloning. */
  flush(): Promise<void>;
};

type CapturedResponseBody = {
  captured: boolean;
  value: unknown;
  settled: Promise<void>;
};

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactCapturedResponseBody(value: unknown, redactionValues: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactionValues.reduce((redacted, secret) => redacted.split(secret).join('[redacted]'), value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactCapturedResponseBody(item, redactionValues));
  }

  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactCapturedResponseBody(item, redactionValues)]),
    );
  }

  return value;
}

function normalizeRedactionValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

/**
 * A failed clone is intentionally omitted instead of changing the provider
 * result. It can happen when a non-standard fetch mock or an aborted response
 * does not support cloning; diagnostics must never alter request semantics.
 */
export function createChatV2ResponseBodyCapture(): ChatV2ResponseBodyCapture {
  const entries: CapturedResponseBody[] = [];
  const bodies: unknown[] = [];

  return {
    bodies,
    capture(response, redactionValues) {
      const entry: CapturedResponseBody = {
        captured: false,
        value: undefined,
        settled: Promise.resolve(),
      };
      entries.push(entry);

      try {
        const responseClone = response.clone();
        const normalizedRedactionValues = normalizeRedactionValues(redactionValues);
        entry.settled = responseClone
          .text()
          .then((text) => {
            entry.value = redactCapturedResponseBody(parseResponseBody(text), normalizedRedactionValues);
            entry.captured = true;
          })
          .catch(() => {
            // The original response remains owned by the provider SDK.
          });
      } catch {
        // A malformed or already-consumed Response has no safe diagnostic body.
      }
    },
    async flush() {
      // New fetches are normally sequential, but continue until no capture was
      // added while an earlier clone was settling.
      let observedEntryCount = 0;
      while (observedEntryCount < entries.length) {
        const pending = entries.slice(observedEntryCount);
        observedEntryCount = entries.length;
        await Promise.allSettled(pending.map((entry) => entry.settled));
      }

      bodies.splice(0, bodies.length, ...entries.filter((entry) => entry.captured).map((entry) => entry.value));
    },
  };
}
