import type {
  ProjectId,
  RivetLLMProfileHealthBeginRequest,
  RivetLLMProfileHealthBeginResult,
  RivetLLMProfileHealthFinishRequest,
  RivetLLMProfileHealthListRequest,
  RivetLLMProfileHealthRenewRequest,
  RivetLLMProfileHealthSnapshot,
  RivetLLMProfileHealthStore,
} from '@valerypopoff/rivet2-node';

export type HttpLLMProfileHealthAdminProvider = {
  list(input: { projectId: ProjectId }): Promise<readonly RivetLLMProfileHealthSnapshot[]>;
  reset(input: { key?: string; projectId: ProjectId }): Promise<void>;
};

export type HttpRivetLLMProfileHealthStoreOptions = {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function createHealthServiceCaller(options: HttpRivetLLMProfileHealthStoreOptions) {
  const baseUrl = trimTrailingSlashes(options.baseUrl);
  const request = options.fetch ?? globalThis.fetch;

  return async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const configuredHeaders = typeof options.headers === 'function' ? options.headers() : options.headers;
    const headers = new Headers(configuredHeaders);
    if (init.body != null) headers.set('content-type', 'application/json');
    const response = await request(`${baseUrl}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LLM Profile health service failed (${response.status} ${response.statusText})${body ? `: ${body}` : ''}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };
}

export function createHttpRivetLLMProfileHealthStore(
  options: HttpRivetLLMProfileHealthStoreOptions,
): RivetLLMProfileHealthStore {
  const call = createHealthServiceCaller(options);

  return {
    begin: (value: RivetLLMProfileHealthBeginRequest) => call<RivetLLMProfileHealthBeginResult>('/begin', {
      method: 'POST', body: JSON.stringify(value),
    }),
    finish: (value: RivetLLMProfileHealthFinishRequest) => call<RivetLLMProfileHealthSnapshot>('/finish', {
      method: 'POST', body: JSON.stringify(value),
    }),
    renew: (value: RivetLLMProfileHealthRenewRequest) => call<RivetLLMProfileHealthSnapshot>('/renew', {
      method: 'POST', body: JSON.stringify(value),
    }),
    async reset(value) {
      if (value.projectId == null) {
        throw new Error('Hosted LLM Profile health reset requires a projectId.');
      }
      await call<void>('/reset', { method: 'POST', body: JSON.stringify(value) });
    },
    async list(value: RivetLLMProfileHealthListRequest = {}) {
      if (value.projectId == null) {
        throw new Error('Hosted LLM Profile health listing requires a projectId.');
      }
      return await call<RivetLLMProfileHealthSnapshot[]>(
        `/?projectId=${encodeURIComponent(String(value.projectId))}`,
      );
    },
  };
}

export function createHttpLLMProfileHealthAdminProvider(
  options: HttpRivetLLMProfileHealthStoreOptions,
): HttpLLMProfileHealthAdminProvider {
  const call = createHealthServiceCaller(options);

  return {
    async list({ projectId }) {
      return await call<RivetLLMProfileHealthSnapshot[]>(
        `/?projectId=${encodeURIComponent(String(projectId))}`,
      );
    },
    async reset(input) {
      await call<void>('/reset', { method: 'POST', body: JSON.stringify(input) });
    },
  };
}
