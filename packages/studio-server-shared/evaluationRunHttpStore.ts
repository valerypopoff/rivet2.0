import type {
  EvaluationDatasetSnapshot,
  EvaluationLibrary,
  EvaluationRecordingArtifact,
  EvaluationRun,
  EvaluationRunEvent,
  EvaluationStore,
  EvaluationStoreInitialization,
} from "@valerypopoff/rivet2-evaluations";

export type LegacyEvaluationLibrarySource = Pick<
  EvaluationStore,
  "getLibrary" | "initialize"
>;

type EvaluationLibrarySnapshot = {
  revision: number;
  library: EvaluationLibrary;
};

function url(baseUrl: string, path = ""): string {
  return `${baseUrl.replace(/\/$/u, "")}${path}`;
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  throw new Error(
    typeof body?.error === "string"
      ? body.error
      : `Evaluation storage request failed (${response.status}).`,
  );
}

function hasLibraryContent(library: EvaluationLibrary): boolean {
  return (
    library.data.suites.length > 0 ||
    library.data.baselines.length > 0 ||
    library.datasets.length > 0 ||
    library.migratedLegacyProjectIds.length > 0
  );
}

/** Complete hosted Evaluations store backed by the wrapper API. */
export function createHttpEvaluationStore(options: {
  baseUrl: string;
  normalizeRun(value: unknown): EvaluationRun;
  normalizeLibrary(value: unknown): EvaluationLibrary;
  legacyLibrarySource?: LegacyEvaluationLibrarySource;
}): EvaluationStore {
  let librarySnapshot: EvaluationLibrarySnapshot | undefined;
  let initializationPromise:
    | Promise<EvaluationStoreInitialization | void>
    | undefined;
  let libraryWrite = Promise.resolve();

  const parseLibrarySnapshot = async (
    response: Response,
  ): Promise<EvaluationLibrarySnapshot> => {
    await requireOk(response);
    const value = (await response.json()) as Partial<EvaluationLibrarySnapshot>;
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
      throw new Error("Evaluation library response has an invalid revision.");
    }
    return {
      revision: Number(value.revision),
      library: options.normalizeLibrary(value.library),
    };
  };

  const fetchLibrary = (): Promise<EvaluationLibrarySnapshot> =>
    fetch(url(options.baseUrl, "/library")).then(parseLibrarySnapshot);

  const initialize = (): Promise<EvaluationStoreInitialization | void> => {
    initializationPromise ??= (async () => {
      let warning: string | undefined;
      const legacySource = options.legacyLibrarySource;
      if (legacySource) {
        let legacyLibrary: EvaluationLibrary | undefined;
        try {
          await legacySource.initialize?.();
          legacyLibrary = await legacySource.getLibrary();
        } catch (error) {
          warning = `The existing browser evaluation library could not be migrated to server storage: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        if (legacyLibrary && hasLibraryContent(legacyLibrary)) {
          // A failed server import must fail initialization. Continuing would let
          // a later project save strip the only remaining legacy copy.
          librarySnapshot = await fetch(
            url(options.baseUrl, "/library/import"),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ library: legacyLibrary }),
            },
          ).then(parseLibrarySnapshot);
        }
      }
      librarySnapshot ??= await fetchLibrary();
      return warning ? { warning } : undefined;
    })();
    return initializationPromise;
  };

  return {
    initialize,
    async getLibrary() {
      await initialize();
      return structuredClone(librarySnapshot!.library);
    },
    async putLibrary(library) {
      const snapshot = structuredClone(library);
      const write = libraryWrite
        .catch(() => undefined)
        .then(async () => {
          await initialize();
          librarySnapshot = await fetch(url(options.baseUrl, "/library"), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision: librarySnapshot!.revision,
              library: snapshot,
            }),
          }).then(parseLibrarySnapshot);
        });
      libraryWrite = write;
      await write;
    },
    async put(run) {
      const response = await fetch(
        url(options.baseUrl, `/${encodeURIComponent(run.id)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: run.projectId, run }),
        },
      );
      await requireOk(response);
    },
    async updateRunName(input) {
      const response = await fetch(
        url(options.baseUrl, `/${encodeURIComponent(input.runId)}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: input.projectId,
            ...(input.name === undefined ? {} : { name: input.name }),
          }),
        },
      );
      if (response.status === 404) return undefined;
      await requireOk(response);
      return options.normalizeRun(await response.json());
    },
    async get(input) {
      const requestUrl = new URL(
        url(options.baseUrl, `/${encodeURIComponent(input.runId)}`),
        window.location.origin,
      );
      requestUrl.searchParams.set("projectId", String(input.projectId));
      const response = await fetch(requestUrl);
      if (response.status === 404) return undefined;
      await requireOk(response);
      return options.normalizeRun(await response.json());
    },
    async list(input) {
      const requestUrl = new URL(url(options.baseUrl), window.location.origin);
      requestUrl.searchParams.set("projectId", String(input.projectId));
      if (input.suiteId != null)
        requestUrl.searchParams.set("suiteId", input.suiteId);
      const response = await fetch(requestUrl);
      await requireOk(response);
      const runs: unknown = await response.json();
      if (!Array.isArray(runs))
        throw new Error("Evaluation run history response must be an array.");
      return runs.map(options.normalizeRun);
    },
    async delete(input) {
      const response = await fetch(
        url(options.baseUrl, `/${encodeURIComponent(input.runId)}`),
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      await requireOk(response);
    },
    async putDatasetSnapshot(snapshot) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/datasets/${encodeURIComponent(snapshot.fingerprint)}`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        },
      );
      await requireOk(response);
    },
    async getDatasetSnapshot(input) {
      const requestUrl = new URL(
        url(
          options.baseUrl,
          `/datasets/${encodeURIComponent(input.fingerprint)}`,
        ),
        window.location.origin,
      );
      requestUrl.searchParams.set("projectId", String(input.projectId));
      const response = await fetch(requestUrl);
      if (response.status === 404) return undefined;
      await requireOk(response);
      return response.json() as Promise<EvaluationDatasetSnapshot>;
    },
    async putRecording(artifact) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/recordings/${encodeURIComponent(artifact.reference.id)}`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(artifact),
        },
      );
      await requireOk(response);
    },
    async getRecording(input) {
      const requestUrl = new URL(
        url(
          options.baseUrl,
          `/recordings/${encodeURIComponent(input.recordingId)}`,
        ),
        window.location.origin,
      );
      requestUrl.searchParams.set("projectId", String(input.projectId));
      const response = await fetch(requestUrl);
      if (response.status === 404) return undefined;
      await requireOk(response);
      return response.json() as Promise<EvaluationRecordingArtifact>;
    },
    async updateRecordingRetention(input) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/recordings/${encodeURIComponent(input.recordingId)}`,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      await requireOk(response);
      const payload = (await response.json()) as { updated?: unknown };
      if (typeof payload.updated !== "boolean") {
        throw new Error("The Evaluation recording retention response is invalid.");
      }
      return payload.updated;
    },
    async promoteBaseline(input) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/${encodeURIComponent(input.runId)}/promote-baseline`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      await requireOk(response);
    },
    async applyRunEvent(event: EvaluationRunEvent) {
      const runId = event.type === "trial-settled" ? event.runId : event.run.id;
      const response = await fetch(
        url(options.baseUrl, `/events/${encodeURIComponent(runId)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        },
      );
      await requireOk(response);
    },
  };
}
