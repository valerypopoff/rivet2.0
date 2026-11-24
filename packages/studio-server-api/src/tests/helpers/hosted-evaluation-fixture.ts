// test-style: fixture-read: loads the canonical serialized project, never implementation source.
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { loadProjectFromString, serializeProject, type ProjectId } from '@valerypopoff/rivet2-node';
import {
  createEmptyEvaluationProjectData,
  type EvaluationDataset,
  type EvaluationSuite,
} from '@valerypopoff/rivet2-evaluations';
import {
  HostedEvaluationCoordinator,
  type HostedEvaluationGraphRunner,
  type HostedEvaluationSubmission,
} from '../../evaluation-runs/hosted-coordinator.js';
import { PostgresRivetEvaluationStore } from '../../evaluation-runs/managed-store.js';
import {
  getHostedEvaluationsCoordinatorConfig,
  type HostedEvaluationsCoordinatorConfig,
} from '../../hosted-evaluations-config.js';

export async function createHostedEvaluationFixture(pool: Pool, cases = 2, projectId = randomUUID() as ProjectId) {
  const project = loadProjectFromString(
    await fs.readFile(
      new URL(
        '../../../../../deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  project.metadata.id = projectId;
  const suite: EvaluationSuite = {
    id: 'fixture-suite',
    name: 'Fixture',
    targetGraphId: project.metadata.mainGraphId!,
    datasetId: 'fixture-data',
    inputBindings: [{ graphInputId: 'input', datasetFieldId: 'input' }],
    assertions: [
      {
        id: 'output',
        name: 'Output',
        outputPath: '$',
        operator: 'type-is',
        expected: { kind: 'literal', value: 'object' },
        required: true,
      },
    ],
    evaluators: [],
    thresholds: [],
    configuration: { trialCount: 1 },
  };
  const dataset: EvaluationDataset = {
    id: suite.datasetId,
    projectId: project.metadata.id,
    name: 'Fixture',
    fields: [{ id: 'input', name: 'Input', dataType: 'string', role: 'input', required: true }],
    cases: Array.from({ length: cases }, (_, index) => ({
      id: `case-${index}`,
      name: `Case ${index}`,
      values: { input: `value-${index}` },
    })),
  };
  await pool.query(
    `INSERT INTO workflows(workflow_id, name, file_name, relative_path, folder_relative_path, current_draft_revision_id)
    VALUES ($1, 'Hosted fixture', 'Hosted.rivet-project', $2, '', 'fixture-draft')`,
    [project.metadata.id, `hosted-${project.metadata.id}.rivet-project`],
  );
  const submission: HostedEvaluationSubmission = {
    projectContents: serializeProject(project) as string,
    projectPath: '/workflows/Hosted.rivet-project',
    evaluationData: { ...createEmptyEvaluationProjectData(), suites: [suite] },
    dataset,
    suiteId: suite.id,
    purpose: 'evaluation',
    runId: `run:${randomUUID()}`,
  };
  const identity = { projectId: project.metadata.id, runId: submission.runId! };
  const store = new PostgresRivetEvaluationStore(pool);
  return {
    identity,
    submission,
    store,
    coordinator(
      options: {
        pool?: Pool;
        runStore?: PostgresRivetEvaluationStore;
        config?: Partial<HostedEvaluationsCoordinatorConfig>;
        runGraph?: HostedEvaluationGraphRunner;
      } = {},
    ) {
      return new HostedEvaluationCoordinator({
        pool: options.pool ?? pool,
        runStore: options.runStore ?? store,
        config: {
          ...getHostedEvaluationsCoordinatorConfig(
            {
              RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
              RIVET_HOSTED_EVALUATIONS_LEASE_MS: '15000',
              RIVET_HOSTED_EVALUATIONS_POLL_MS: '250',
              RIVET_HOSTED_EVALUATIONS_MAX_JOBS_PER_RUN: '100',
              RIVET_HOSTED_EVALUATIONS_MAX_OUTSTANDING_JOBS: '100',
            },
            'control',
            true,
          ),
          ...options.config,
        },
        runGraph:
          options.runGraph ??
          (async ({ inputs }) => ({ outputs: { output: inputs.input! }, metrics: { durationMs: 1 } })),
      });
    },
    async dispose() {
      await pool.query('DELETE FROM workflows WHERE workflow_id = $1', [identity.projectId]);
    },
  };
}
