import Select from '@atlaskit/select';
import { type FC } from 'react';

export type RecordingWorkflowOption = {
  label: string;
  value: string;
  description: string;
  endpoint: string;
  statusLabel: string;
  recordingCount: number | null;
};

type RecordingWorkflowSelectProps = {
  workflowOptions: RecordingWorkflowOption[];
  selectedWorkflowId: string;
  onSelectWorkflow: (workflowId: string) => void;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
};

function formatRecordingCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'recording' : 'recordings'}`;
}

export const RecordingWorkflowSelect: FC<RecordingWorkflowSelectProps> = ({
  workflowOptions,
  selectedWorkflowId,
  onSelectWorkflow,
  isLoading,
  error,
  onRetry,
}) => (
  <section className="run-recordings-selector-section">
    <label className="run-recordings-field-label" htmlFor="run-recordings-workflow-select">
      Project
    </label>
    <Select
      inputId="run-recordings-workflow-select"
      options={workflowOptions}
      isLoading={isLoading}
      value={workflowOptions.find((option) => option.value === selectedWorkflowId) ?? null}
      onChange={(option: RecordingWorkflowOption | null) => {
        onSelectWorkflow(option?.value ?? '');
      }}
      isSearchable
      classNamePrefix="run-recordings-select"
      formatOptionLabel={(option: RecordingWorkflowOption, { context }: { context: 'menu' | 'value' }) => (
        <div className="run-recordings-select-option">
          <div className="run-recordings-select-option-title-row">
            <div className="run-recordings-select-option-title">{option.label}</div>
            {context === 'menu' ? (
              <div className="run-recordings-select-option-count">
                {option.recordingCount === null
                  ? isLoading
                    ? 'Loading count…'
                    : 'Count unavailable'
                  : `${formatRecordingCount(option.recordingCount)}${option.value ? ' in this project' : ''}`}
              </div>
            ) : null}
          </div>
          {context === 'menu' ? (
            <div className="run-recordings-select-option-meta">
              {[option.statusLabel, option.endpoint ? `/workflows/${option.endpoint}` : '', option.description]
                .filter(Boolean)
                .join(' - ')}
            </div>
          ) : null}
        </div>
      )}
    />
    {error ? (
      <div className="project-settings-error run-recordings-catalog-error" role="alert">
        Could not load projects: {error}{' '}
        <button type="button" className="run-recordings-page-button" onClick={onRetry}>
          Retry loading projects
        </button>
      </div>
    ) : null}
  </section>
);
