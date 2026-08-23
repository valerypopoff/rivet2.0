import type {
  EvaluationDatasetSnapshot,
  EvaluationRecordingArtifact,
  EvaluationRun,
  EvaluationRunStore,
} from "@valerypopoff/rivet2-evaluations";

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
      : `Evaluation run request failed (${response.status}).`,
  );
}

/** Shared hosted-editor history; the server is responsible for project scoping. */
export function createHttpEvaluationRunStore(options: {
  baseUrl: string;
  normalizeRun(value: unknown): EvaluationRun;
}): EvaluationRunStore {
  return {
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
    },    async get(input) {
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
  };
}
