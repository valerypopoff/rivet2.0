export async function invoke<T>(_command: string, _args?: Record<string, unknown>): Promise<T> {
  throw new Error('Native Tauri commands are unavailable in hosted mode');
}
