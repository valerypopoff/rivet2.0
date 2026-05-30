import Select from '@atlaskit/select';
import { type FC } from 'react';

export type RecordingWorkflowOption = {
  label: string;
  value: string;
  description: string;
  endpoint: string;
  statusLabel: string;
  recordingCount: number;
};

type RecordingWorkflowSelectProps = {
  workflowOptions: RecordingWorkflowOption[];
  selectedWorkflowId: string;
  onSelectWorkflow: (workflowId: string) => void;
};

function formatRecordingCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'recording' : 'recordings'}`;
}

export const RecordingWorkflowSelect: FC<RecordingWorkflowSelectProps> = ({
  workflowOptions,
  selectedWorkflowId,
  onSelectWorkflow,
}) => (
  <section className="run-recordings-selector-section">
    <div className="run-recordings-field-label">Workflow</div>
    <Select
      inputId="run-recordings-workflow-select"
      options={workflowOptions}
      value={workflowOptions.find((option) => option.value === selectedWorkflowId) ?? null}
      onChange={(option: RecordingWorkflowOption | null) => {
        onSelectWorkflow(option?.value ?? '');
      }}
      isSearchable={workflowOptions.length > 8}
      classNamePrefix="run-recordings-select"
      formatOptionLabel={(option: RecordingWorkflowOption, { context }: { context: 'menu' | 'value' }) => (
        <div className="run-recordings-select-option">
          <div className="run-recordings-select-option-title-row">
            <div className="run-recordings-select-option-title">{option.label}</div>
            {context === 'menu' ? (
              <div className="run-recordings-select-option-count">
                {formatRecordingCount(option.recordingCount)}
              </div>
            ) : null}
          </div>
          {context === 'menu' ? (
            <div className="run-recordings-select-option-meta">
              {option.statusLabel}
              {option.endpoint ? ` - /workflows/${option.endpoint}` : ''}
              {option.description ? ` - ${option.description}` : ''}
            </div>
          ) : null}
        </div>
      )}
    />
  </section>
);
