import type {
  EvaluationRunHistoryPage,
  EvaluationRunHistoryQuery,
  EvaluationRun,
  EvaluationRunSummary,
} from '@valerypopoff/rivet2-evaluations';
import { normalizeEvaluationRun } from '@valerypopoff/rivet2-evaluations';

export type EvaluationHistoryRow = {
  run_id: string;
  project_id: string;
  suite_id: string;
  started_at: string | Date;
  started_at_cursor?: string;
  summary_json: string | EvaluationRunSummary;
};

/** Shared SQLite/PostgreSQL ordering and cursor semantics. Scope is encoded in
 * the cursor so a page token cannot accidentally cross project/suite boundaries. */
export function evaluationHistoryPageQuery(dialect: 'sqlite' | 'postgres', input: EvaluationRunHistoryQuery) {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid evaluation history page size.');
  const values: unknown[] = [String(input.projectId)];
  const bind = (value: unknown) => {
    values.push(value);
    return dialect === 'sqlite' ? '?' : `$${values.length}`;
  };
  const clauses = [`project_id = ${dialect === 'sqlite' ? '?' : '$1'}`];
  if (input.suiteId !== undefined) clauses.push(`suite_id = ${bind(input.suiteId)}`);
  if (input.after !== undefined) {
    if (input.after.length > 2048) throw new Error('Invalid evaluation history cursor.');
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid evaluation history cursor.');
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 4 ||
      cursor[0] !== String(input.projectId) ||
      cursor[1] !== (input.suiteId ?? null) ||
      typeof cursor[2] !== 'string' ||
      !Number.isFinite(Date.parse(cursor[2])) ||
      typeof cursor[3] !== 'string' ||
      !cursor[3]
    )
      throw new Error('Invalid evaluation history cursor.');
    clauses.push(`(started_at, run_id) < (${bind(cursor[2])}, ${bind(cursor[3])})`);
  }
  const projection =
    dialect === 'sqlite'
      ? "CASE WHEN json_extract(run_json, '$.version') = 2 THEN json_remove(run_json, '$.trials', '$.thresholdResults', '$.warnings', '$.provenance') ELSE run_json END"
      : "CASE WHEN run_json::jsonb ->> 'version' = '2' THEN run_json::jsonb - 'trials' - 'thresholdResults' - 'warnings' - 'provenance' ELSE run_json::jsonb END";
  // pg's Date parser discards microseconds; SQLite compares timestamp strings
  // verbatim. Carry the exact SQL value through the cursor for both backends.
  const cursorTimestamp =
    dialect === 'postgres' ? `TO_CHAR(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : 'started_at';
  const sql = `SELECT run_id, project_id, suite_id, started_at, ${cursorTimestamp} AS started_at_cursor, ${projection} AS summary_json FROM evaluation_runs WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC, run_id DESC LIMIT ${bind(limit + 1)}`;
  return {
    sql,
    values,
    page(rows: EvaluationHistoryRow[]): EvaluationRunHistoryPage {
      const runs = rows.slice(0, limit).map((row) => {
        const raw =
          typeof row.summary_json === 'string'
            ? (JSON.parse(row.summary_json) as EvaluationRunSummary)
            : row.summary_json;
        // Legacy quality labels depend on actual trial evidence. Normalize that
        // bounded page using the existing authority, not a guessed header label.
        const normalized = raw?.version === 2 ? raw : normalizeEvaluationRun(raw);
        // A cursor must describe the SQL ordering, not an independently edited
        // JSON header. Inconsistent stored identities must fail closed.
        if (
          !normalized ||
          typeof normalized.id !== 'string' ||
          !normalized.id ||
          normalized.projectId !== input.projectId ||
          (input.suiteId !== undefined && normalized.suiteId !== input.suiteId) ||
          typeof normalized.startedAt !== 'string' ||
          !Number.isFinite(Date.parse(normalized.startedAt)) ||
          normalized.id !== row.run_id ||
          normalized.projectId !== row.project_id ||
          normalized.suiteId !== row.suite_id ||
          Date.parse(normalized.startedAt) !== new Date(row.started_at_cursor ?? row.started_at).getTime()
        )
          throw new Error('Invalid evaluation history metadata.');
        const {
          trials: _trials,
          thresholdResults: _thresholds,
          warnings: _warnings,
          provenance: _provenance,
          _hostedTrialsFromJobs: _hostedTrials,
          ...summary
        } = normalized as EvaluationRun & { _hostedTrialsFromJobs?: boolean };
        return summary;
      });
      const last = rows[Math.min(rows.length, limit) - 1];
      const timestamp =
        last?.started_at_cursor ??
        (last?.started_at instanceof Date ? last.started_at.toISOString() : last?.started_at);
      return {
        runs,
        ...(rows.length > limit && last
          ? {
              nextCursor: Buffer.from(
                JSON.stringify([String(input.projectId), input.suiteId ?? null, timestamp, last.run_id]),
              ).toString('base64url'),
            }
          : {}),
      };
    },
  };
}
