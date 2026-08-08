import { Field } from '@atlaskit/form';
import { useAtom } from 'jotai';
import { type FC } from 'react';
import {
  graphBuilderImplementationModeState,
  recordExecutionsState,
  showNodeRunDurationsState,
} from '../../../state/settings.js';
import { showGraphReferenceIndicatorsState, showUnreachableGraphTagsState } from '../../../state/ui.js';
import { LabeledToggle } from '../../LabeledToggle.js';
import { SegmentedEditor } from '../../editors/SegmentedEditor.js';
import { fields } from '../settingsPageStyles.js';
import { isRivetAppHostCapabilityEnabled, useRivetAppHostUiConfig } from '../../../providers/HostUiConfigContext.js';

const graphBuilderImplementationOptions = [
  { label: 'Transactional', value: 'plan-b' },
  { label: 'Legacy rollback', value: 'legacy' },
] as const;

export const GraphsSettingsPage: FC = () => {
  const hostUiConfig = useRivetAppHostUiConfig();
  const aiGraphBuilderEnabled = isRivetAppHostCapabilityEnabled(hostUiConfig, 'aiGraphBuilder');
  const [recordExecutions, setRecordExecutions] = useAtom(recordExecutionsState);
  const [showNodeRunDurations, setShowNodeRunDurations] = useAtom(showNodeRunDurationsState);
  const [showUnreachableGraphTags, setShowUnreachableGraphTags] = useAtom(showUnreachableGraphTagsState);
  const [showGraphReferenceIndicators, setShowGraphReferenceIndicators] = useAtom(showGraphReferenceIndicatorsState);
  const [graphBuilderImplementationMode, setGraphBuilderImplementationMode] = useAtom(
    graphBuilderImplementationModeState,
  );

  const changeGraphBuilderImplementationMode = (value: string | boolean) => {
    if (value === 'legacy' || value === 'plan-b') {
      setGraphBuilderImplementationMode(value);
    }
  };

  return (
    <div css={fields}>
      <Field name="recordExecutions">
        {() => (
          <LabeledToggle
            id="recordExecutions"
            isChecked={recordExecutions}
            onChange={setRecordExecutions}
            label="Record local graph executions"
            helperMessage="Disabling may help performance when dealing with very large data values."
            className="settings-toggle-field"
          />
        )}
      </Field>
      <Field name="show-node-run-durations">
        {() => (
          <LabeledToggle
            id="show-node-run-durations"
            isChecked={showNodeRunDurations}
            onChange={setShowNodeRunDurations}
            label="Show node run durations"
            helperMessage="Displays each node's run duration in node outputs. Timing is captured only when needed for this view, remote debugging, or recording replay."
            className="settings-toggle-field"
          />
        )}
      </Field>
      <Field name="show-unreachable-graph-tags">
        {() => (
          <LabeledToggle
            id="show-unreachable-graph-tags"
            isChecked={showUnreachableGraphTags}
            onChange={setShowUnreachableGraphTags}
            label="Show unreachable graph indicators"
            helperMessage="Marks graphs that are not reachable from the project's Main Graph or a web app action."
            className="settings-toggle-field"
          />
        )}
      </Field>
      <Field name="show-graph-reference-indicators">
        {() => (
          <LabeledToggle
            id="show-graph-reference-indicators"
            isChecked={showGraphReferenceIndicators}
            onChange={setShowGraphReferenceIndicators}
            label="Show graph reference indicators"
            helperMessage="Shows graphs and web apps that directly reference the currently open graph."
            className="settings-toggle-field"
          />
        )}
      </Field>
      {aiGraphBuilderEnabled ? (
        <SegmentedEditor
          value={graphBuilderImplementationMode}
          onChange={changeGraphBuilderImplementationMode}
          isReadonly={false}
          isDisabled={false}
          label="Graph Builder implementation"
          name="graphBuilderImplementationMode"
          helperMessage="Developer rollout control. Legacy remains the default until the evaluation and dogfood gates pass. Transactional builds a private draft for review before Apply. A running session keeps the implementation it started with; changes affect only new sessions."
          options={graphBuilderImplementationOptions}
        />
      ) : null}
    </div>
  );
};
