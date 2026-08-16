import { css } from '@emotion/react';
import type { EvaluationDataset, EvaluationSuite } from '@valerypopoff/rivet2-evaluations';
import type { FC } from 'react';
import type { EvaluationSuiteReferenceStatus } from './evaluationWorkspaceModel.js';

const styles = css`
  min-width: 0;
  border-right: 1px solid var(--grey-darkish);
  background: var(--grey-darker);
  padding: 16px 0;
  overflow-y: auto;
  user-select: none;

  .evaluation-sidebar-section {
    padding: 0 0 16px;
  }

  .evaluation-sidebar-section + .evaluation-sidebar-section {
    padding-top: 16px;
    border-top: 1px solid var(--grey-darkish);
  }

  .evaluation-sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 14px 12px 16px;
  }

  h2 {
    margin: 0;
    font-size: var(--ui-font-size-base);
  }

  .add-suite {
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--grey-light);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    padding: 5px 8px;
  }

  .add-suite:hover:not(:disabled) {
    background: var(--grey-darkish);
    color: var(--foreground);
  }

  .add-suite:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .suite-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 8px;
  }

  .suite-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    width: 100%;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    padding: 9px 10px;
    text-align: left;
  }

  .suite-row:hover {
    background: var(--grey-darkerish);
  }

  .suite-row[aria-current='true'] {
    background: color-mix(in srgb, var(--primary) 24%, var(--grey-darker));
    color: var(--foreground);
  }

  .suite-copy {
    min-width: 0;
  }

  .suite-name,
  .suite-target {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .suite-name {
    font-weight: 600;
  }

  .suite-target {
    margin-top: 3px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }

  .suite-warning {
    align-self: center;
    color: var(--warning);
  }

  .empty-suite-list {
    margin: 8px 16px;
    color: var(--grey-light);
  }
`;

export const EvaluationSuiteSidebar: FC<{
  canCreateDataset: boolean;
  canCreateSuite: boolean;
  datasets: readonly EvaluationDataset[];
  getDatasetUsage: (dataset: EvaluationDataset) => string;
  selectedSuiteId?: string;
  selectedDatasetId?: string;
  suites: readonly EvaluationSuite[];
  getGraphName: (suite: EvaluationSuite) => string;
  getReferenceStatus: (suite: EvaluationSuite) => EvaluationSuiteReferenceStatus;
  onCreateDataset: () => void;
  onCreateSuite: () => void;
  onSelectDataset: (datasetId: string) => void;
  onSelectSuite: (suiteId: string) => void;
}> = ({
  canCreateDataset,
  canCreateSuite,
  datasets,
  getDatasetUsage,
  selectedSuiteId,
  selectedDatasetId,
  suites,
  getGraphName,
  getReferenceStatus,
  onCreateDataset,
  onCreateSuite,
  onSelectDataset,
  onSelectSuite,
}) => (
  <aside css={styles} aria-label="Evaluations resources">
    <section className="evaluation-sidebar-section" aria-labelledby="evaluation-suites-heading">
      <div className="evaluation-sidebar-header">
        <h2 id="evaluation-suites-heading">Evaluation suites</h2>
        <button
          type="button"
          className="add-suite"
          disabled={!canCreateSuite}
          title={canCreateSuite ? 'Create evaluation suite' : 'Create a graph before creating an evaluation suite'}
          aria-label="Create evaluation suite"
          onClick={onCreateSuite}
        >
          +
        </button>
      </div>
      <div className="suite-list">
        {suites.length === 0 ? (
          <p className="empty-suite-list">No evaluation suites yet.</p>
        ) : (
          suites.map((suite) => {
            const status = getReferenceStatus(suite);
            const broken = !status.datasetExists || !status.targetGraphExists || !status.evaluatorGraphsExist;
            return (
              <button
                type="button"
                className="suite-row"
                key={suite.id}
                aria-current={suite.id === selectedSuiteId}
                onClick={() => onSelectSuite(suite.id)}
              >
                <span className="suite-copy">
                  <span className="suite-name">{suite.name || 'Untitled evaluation suite'}</span>
                  <span className="suite-target">{getGraphName(suite)}</span>
                </span>
                {broken ? (
                  <span
                    className="suite-warning"
                    title="This suite has a missing target graph, evaluator graph, or dataset reference"
                  >
                    ⚠
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </section>
    <section className="evaluation-sidebar-section" aria-labelledby="evaluation-datasets-heading">
      <div className="evaluation-sidebar-header">
        <h2 id="evaluation-datasets-heading">Datasets</h2>
        <button
          type="button"
          className="add-suite"
          disabled={!canCreateDataset}
          title="Create evaluation dataset"
          aria-label="Create evaluation dataset"
          onClick={onCreateDataset}
        >
          +
        </button>
      </div>
      <div className="suite-list">
        {datasets.length === 0 ? (
          <p className="empty-suite-list">No evaluation datasets yet.</p>
        ) : (
          datasets.map((dataset) => (
            <button
              type="button"
              className="suite-row"
              key={dataset.id}
              aria-current={dataset.id === selectedDatasetId}
              onClick={() => onSelectDataset(dataset.id)}
            >
              <span className="suite-copy">
                <span className="suite-name">{dataset.name || 'Untitled evaluation dataset'}</span>
                <span className="suite-target">{getDatasetUsage(dataset)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  </aside>
);
