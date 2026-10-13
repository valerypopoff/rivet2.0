import type { EvaluationRun } from '@valerypopoff/rivet2-evaluations';

/** An internal storage marker, never an additional public Evaluation format.
 * A single SQL statement assembles header and jobs from the same MVCC snapshot. */
export const HOSTED_TRIAL_PROJECTION_KEY = '_hostedTrialsFromJobs';

export function hostedEvaluationHeader(run: EvaluationRun) {
  return { ...run, trials: [], [HOSTED_TRIAL_PROJECTION_KEY]: true };
}

/** Generic snapshots cannot opt into the scheduler's internal representation. */
export function withoutHostedProjectionMarker(run: EvaluationRun): EvaluationRun {
  const { [HOSTED_TRIAL_PROJECTION_KEY]: _marker, ...publicRun } = run as EvaluationRun & {
    [HOSTED_TRIAL_PROJECTION_KEY]?: unknown;
  };
  return publicRun;
}

export function assembledEvaluationRunSql(alias = 'evaluation_runs'): string {
  return `CASE WHEN ${alias}.run_json->>'${HOSTED_TRIAL_PROJECTION_KEY}' = 'true'
    THEN jsonb_set(${alias}.run_json - '${HOSTED_TRIAL_PROJECTION_KEY}', '{trials}',
      COALESCE((SELECT jsonb_agg(job.trial_json ORDER BY job.case_index, job.trial_index)
        FROM evaluation_hosted_trial_jobs job
        WHERE job.project_id = ${alias}.project_id AND job.run_id = ${alias}.run_id
          AND job.trial_json IS NOT NULL), '[]'::jsonb))
    ELSE ${alias}.run_json END`;
}
