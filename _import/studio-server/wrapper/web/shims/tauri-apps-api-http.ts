// Shim for @tauri-apps/api/http
// Translates Tauri HTTP client interface to browser fetch

export enum ResponseType {
  JSON = 1,
  Text = 2,
  Binary = 3,
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  responseType?: ResponseType;
  url?: string;
}

export interface TauriResponse<T> {
  url: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  data: T;
}

async function convertResponse<T>(resp: Response, responseType?: ResponseType): Promise<TauriResponse<T>> {
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let data: any;
  if (responseType === ResponseType.Binary) {
    const buffer = await resp.arrayBuffer();
    data = Array.from(new Uint8Array(buffer));
  } else if (responseType === ResponseType.Text) {
    data = await resp.text();
  } else {
    // Default to JSON
    const text = await resp.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    url: resp.url,
    status: resp.status,
    ok: resp.ok,
    headers,
    data,
  };
}

export async function fetch<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>> {
  const resp = await globalThis.fetch(url, {
    method: options?.method ?? 'GET',
    headers: options?.headers,
    body: options?.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });

  return convertResponse<T>(resp, options?.responseType);
}

export interface HttpClient {
  get<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>>;
  post<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>>;
  put<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>>;
  delete<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>>;
  patch<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>>;
  request<T>(options: HttpOptions & { url: string }): Promise<TauriResponse<T>>;
  drop(): void;
}

export async function getClient(): Promise<HttpClient> {
  return {
    async get<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>> {
      return fetch<T>(url, { ...options, method: 'GET' });
    },
    async post<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>> {
      return fetch<T>(url, { ...options, method: 'POST' });
    },
    async put<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>> {
      return fetch<T>(url, { ...options, method: 'PUT' });
    },
    async delete<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>> {
      return fetch<T>(url, { ...options, method: 'DELETE' });
    },
    async patch<T>(url: string, options?: HttpOptions): Promise<TauriResponse<T>> {
      return fetch<T>(url, { ...options, method: 'PATCH' });
    },
    async request<T>(options: HttpOptions & { url: string }): Promise<TauriResponse<T>> {
      return fetch<T>(options.url, options);
    },
    drop() {
      // no-op
    },
  };
}

export class Body {
  static form(data: Record<string, any>): any {
    return data;
  }
  static json(data: any): any {
    return JSON.stringify(data);
  }
  static text(data: string): any {
    return data;
  }
  static bytes(data: Uint8Array): any {
    return data;
  }
}
