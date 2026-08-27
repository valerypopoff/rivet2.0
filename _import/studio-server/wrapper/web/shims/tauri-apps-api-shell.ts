// Shim for @tauri-apps/api/shell
// Command class -> calls POST /api/shell/exec
// open(url) -> window.open(url)

import { RIVET_API_BASE_URL } from '../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

type EventCallback = (data: string) => void;

class EventEmitter {
  private listeners: Map<string, EventCallback[]> = new Map();

  on(event: string, cb: EventCallback) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }

  emit(event: string, data: string) {
    const arr = this.listeners.get(event);
    if (arr) {
      for (const cb of arr) {
        cb(data);
      }
    }
  }
}

export interface ChildProcess {
  code: number;
  stdout: string;
  stderr: string;
  signal: number | null;
}

export class Child {
  pid: number;
  constructor(pid: number) {
    this.pid = pid;
  }
  async kill(): Promise<void> {
    // no-op
  }
  async write(_data: string): Promise<void> {
    // no-op
  }
}

export class Command {
  private program: string;
  private args: string[];
  private options: { cwd?: string; encoding?: string };

  stdout: EventEmitter = new EventEmitter();
  stderr: EventEmitter = new EventEmitter();

  constructor(program: string, args?: string | string[], options?: { cwd?: string; encoding?: string }) {
    this.program = program;
    this.args = Array.isArray(args) ? args : args ? [args] : [];
    this.options = options ?? {};
  }

  static sidecar(_path: string, _args?: string | string[], _options?: any): Command {
    // Return a no-op command for sidecar (executor runs as Docker service)
    const cmd = new Command('__sidecar_noop__', []);
    return cmd;
  }

  async execute(): Promise<ChildProcess> {
    if (this.program === '__sidecar_noop__') {
      return { code: 0, stdout: '', stderr: '', signal: null };
    }

    try {
      const resp = await fetch(`${API}/shell/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          program: this.program,
          args: this.args,
          options: { cwd: this.options.cwd, encoding: this.options.encoding },
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return { code: 1, stdout: '', stderr: `Shell exec failed: ${text}`, signal: null };
      }

      const result = await resp.json();

      // Emit buffered stdout/stderr through event emitters
      if (result.stdout) {
        this.stdout.emit('data', result.stdout);
      }
      if (result.stderr) {
        this.stderr.emit('data', result.stderr);
      }

      return {
        code: result.code ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        signal: null,
      };
    } catch (err: any) {
      return { code: 1, stdout: '', stderr: err.message ?? 'Unknown error', signal: null };
    }
  }

  async spawn(): Promise<Child> {
    if (this.program === '__sidecar_noop__') {
      return new Child(0);
    }
    // For non-sidecar, execute and return a child
    this.execute();
    return new Child(0);
  }
}

export async function open(url: string): Promise<void> {
  window.open(url, '_blank');
}
