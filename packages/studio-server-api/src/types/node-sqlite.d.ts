declare module 'node:sqlite' {
  export type RunResult = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  export class StatementSync {
    run(...params: unknown[]): RunResult;
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
