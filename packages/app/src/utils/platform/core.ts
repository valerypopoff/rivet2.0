export type NativeCommandResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

export type NativeDataStream = {
  on(event: 'data', handler: (data: string) => void): void;
  off?(event: 'data', handler: (data: string) => void): void;
  removeAllListeners?(event?: 'data'): void;
  removeListener?(event: 'data', handler: (data: string) => void): void;
};

export type NativeChildProcess = {
  kill(): void | Promise<void>;
};

export type NativeCommand = {
  execute(): Promise<NativeCommandResult>;
  spawn(): Promise<NativeChildProcess>;
  stderr: NativeDataStream;
  stdout: NativeDataStream;
};

type CommandLike = {
  execute(): Promise<{ code: number | null; stderr: string; stdout: string }>;
  spawn(): Promise<NativeChildProcess>;
  stderr: NativeDataStream;
  stdout: NativeDataStream;
};

export type NativeWindowListener = () => void | Promise<void>;

export type NativeWindowHandle = {
  close(): Promise<void>;
  isMaximized?(): Promise<boolean>;
  listen?<T = unknown>(event: string, handler: (event: { payload: T }) => void): Promise<NativeWindowListener>;
  minimize?(): Promise<void>;
  onCloseRequested?(handler: () => void): Promise<NativeWindowListener>;
  onMenuClicked?(handler: (event: { payload: string }) => void): Promise<NativeWindowListener>;
  once?(event: string, handler: (event: unknown) => void): Promise<NativeWindowListener>;
  setTitle?(title: string): Promise<void>;
  startDragging?(): Promise<void>;
  toggleMaximize?(): Promise<void>;
};

export function isInTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);
}

export function unsupported(feature: string): never {
  throw new Error(`${feature} is only available in the desktop app`);
}

export async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isInTauri()) {
    unsupported(`Native command "${command}"`);
  }

  const { invoke } = await import('@tauri-apps/api/tauri');
  return await invoke<T>(command, args);
}

export type { CommandLike };
