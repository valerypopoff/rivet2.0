// Shim for @tauri-apps/api/window
// appWindow -> stub with no-op setTitle()
// getCurrent() -> throws (makes isInTauri() return false)
// WebviewWindow -> opens browser popup via window.open()

export class WebviewWindow {
  label: string;
  private windowRef: Window | null = null;

  constructor(label: string, options?: { url?: string; title?: string; width?: number; height?: number }) {
    this.label = label;
    if (options?.url) {
      const width = options.width ?? 800;
      const height = options.height ?? 600;
      this.windowRef = window.open(
        options.url,
        label,
        `width=${width},height=${height},menubar=no,toolbar=no`,
      );
    }
  }

  async setTitle(_title: string): Promise<void> {
    // no-op
  }

  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {
    this.windowRef?.close();
  }
  async center(): Promise<void> {}
  async setFocus(): Promise<void> {
    this.windowRef?.focus();
  }
  async setAlwaysOnTop(_alwaysOnTop: boolean): Promise<void> {}
  async setSize(_size: any): Promise<void> {}
  async setMinSize(_size: any): Promise<void> {}
  async setPosition(_position: any): Promise<void> {}
  async setResizable(_resizable: boolean): Promise<void> {}
  async setDecorations(_decorations: boolean): Promise<void> {}
  async isVisible(): Promise<boolean> { return true; }
  async isDecorated(): Promise<boolean> { return true; }
  async isResizable(): Promise<boolean> { return true; }
  async isMaximized(): Promise<boolean> { return false; }
  async isMinimized(): Promise<boolean> { return false; }

  async onCloseRequested(handler: (event: any) => void): Promise<() => void> {
    return () => {};
  }

  async once(event: string, handler: (event: any) => void): Promise<() => void> {
    return () => {};
  }

  async listen(event: string, handler: (event: any) => void): Promise<() => void> {
    return () => {};
  }

  async emit(event: string, payload?: any): Promise<void> {}
}

class AppWindow {
  label = 'main';

  async setTitle(title: string): Promise<void> {
    document.title = title;
  }

  async show(): Promise<void> {}
  async hide(): Promise<void> {}
  async close(): Promise<void> {}
  async center(): Promise<void> {}
  async setFocus(): Promise<void> {}
  async setAlwaysOnTop(_alwaysOnTop: boolean): Promise<void> {}
  async setSize(_size: any): Promise<void> {}
  async setMinSize(_size: any): Promise<void> {}
  async setMaxSize(_size: any): Promise<void> {}
  async setPosition(_position: any): Promise<void> {}
  async setResizable(_resizable: boolean): Promise<void> {}
  async setDecorations(_decorations: boolean): Promise<void> {}
  async isVisible(): Promise<boolean> { return true; }
  async isDecorated(): Promise<boolean> { return true; }
  async isResizable(): Promise<boolean> { return true; }
  async isMaximized(): Promise<boolean> { return false; }
  async isMinimized(): Promise<boolean> { return false; }
  async maximize(): Promise<void> {}
  async unmaximize(): Promise<void> {}
  async minimize(): Promise<void> {}
  async unminimize(): Promise<void> {}

  async onMenuClicked(_handler: (payload: { payload: string }) => void): Promise<() => void> {
    return () => {};
  }

  async onCloseRequested(handler: (event: any) => void): Promise<() => void> {
    return () => {};
  }

  async once(event: string, handler: (event: any) => void): Promise<() => void> {
    return () => {};
  }

  async listen(event: string, handler: (event: any) => void): Promise<() => void> {
    return () => {};
  }

  async emit(event: string, payload?: any): Promise<void> {}
}

export const appWindow = new AppWindow();

export function getCurrent(): any {
  throw new Error('Not running in Tauri');
}

export function getAll(): any[] {
  return [];
}

export class LogicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export class PhysicalSize {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

export class LogicalPosition {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export class PhysicalPosition {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}
