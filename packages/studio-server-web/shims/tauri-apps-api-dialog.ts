// Shim for @tauri-apps/api/dialog
// Routes open/save to browser File System Access API or API-backed operations

export interface OpenDialogOptions {
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
  directory?: boolean;
  recursive?: boolean;
  title?: string;
  defaultPath?: string;
}

export interface SaveDialogOptions {
  filters?: { name: string; extensions: string[] }[];
  title?: string;
  defaultPath?: string;
}

function getSupportedPickerExtensions(extensions: string[] | undefined): string[] {
  return (extensions ?? [])
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
    // File System Access type filters reject custom extensions with characters like "-".
    .filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension));
}

export async function open(options?: OpenDialogOptions): Promise<string | string[] | null> {
  if (options?.directory) {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await (window as any).showDirectoryPicker();
        return handle.name;
      } catch {
        return null;
      }
    }
    return null;
  }

  if ('showOpenFilePicker' in window) {
    try {
      const accepts: { description?: string; accept?: Record<string, string[]> }[] = [];
      if (options?.filters) {
        for (const filter of options.filters) {
          const supportedExtensions = getSupportedPickerExtensions(filter.extensions);
          if (supportedExtensions.length === 0) {
            continue;
          }

          accepts.push({
            description: filter.name,
            accept: {
              'application/octet-stream': supportedExtensions,
            },
          });
        }
      }
      const handles = await (window as any).showOpenFilePicker({
        multiple: options?.multiple ?? false,
        types: accepts.length > 0 ? accepts : undefined,
      });
      if (options?.multiple) {
        return Promise.all(handles.map((h: any) => h.name));
      }
      return handles[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

export async function save(options?: SaveDialogOptions): Promise<string | null> {
  if ('showSaveFilePicker' in window) {
    try {
      const types: any[] = [];
      if (options?.filters) {
        for (const filter of options.filters) {
          const supportedExtensions = getSupportedPickerExtensions(filter.extensions);
          if (supportedExtensions.length === 0) {
            continue;
          }

          types.push({
            description: filter.name,
            accept: {
              'application/octet-stream': supportedExtensions,
            },
          });
        }
      }
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: options?.defaultPath,
        types: types.length > 0 ? types : undefined,
      });
      return handle.name;
    } catch {
      return null;
    }
  }
  return null;
}

export async function message(msg: string, options?: any): Promise<void> {
  alert(msg);
}

export async function ask(msg: string, options?: any): Promise<boolean> {
  return confirm(msg);
}

export async function confirm(msg: string, options?: any): Promise<boolean> {
  return globalThis.confirm(msg);
}
