import type { PoolClient } from 'pg';
import type { ProjectId } from '@valerypopoff/rivet2-node';

/** Caller owns the transaction. All entry points share the scheduler's
 * job -> scheduler -> projection lock order, including generic store deletion. */
export async function deleteManagedEvaluationRun(
  client: PoolClient,
  input: { projectId: ProjectId; runId: string },
): Promise<void> {
  const key = [String(input.projectId), input.runId];
  const jobs = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_hosted_trial_jobs
       WHERE project_id = $1 AND run_id = $2 ORDER BY job_id FOR UPDATE`,
    key,
  );
  const hosted = await client.query<{ status: string }>(
    `SELECT status FROM evaluation_hosted_runs WHERE project_id = $1 AND run_id = $2 FOR UPDATE`,
    key,
  );
  if (
    hosted.rows.some((run) => run.status === 'queued' || run.status === 'running') ||
    jobs.rows.some((job) => ['queued', 'claimed', 'accepted'].includes(job.status))
  ) {
    throw new Error(
      'A queued or running hosted Evaluation cannot be deleted. Cancel it first so completed evidence remains auditable.',
    );
  }
  await client.query('DELETE FROM evaluation_recordings WHERE project_id = $1 AND run_id = $2', key);
  await client.query('DELETE FROM evaluation_runs WHERE project_id = $1 AND run_id = $2', key);
}
