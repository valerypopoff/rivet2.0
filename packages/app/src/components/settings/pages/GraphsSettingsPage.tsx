import { Field } from '@atlaskit/form';
import { useAtom } from 'jotai';
import { type FC } from 'react';
import { recordExecutionsState, showNodeRunDurationsState } from '../../../state/settings.js';
import { showGraphReferenceIndicatorsState, showUnreachableGraphTagsState } from '../../../state/ui.js';
import { LabeledToggle } from '../../LabeledToggle.js';
import { fields } from '../settingsPageStyles.js';

export const GraphsSettingsPage: FC = () => {
  const [recordExecutions, setRecordExecutions] = useAtom(recordExecutionsState);
  const [showNodeRunDurations, setShowNodeRunDurations] = useAtom(showNodeRunDurationsState);
  const [showUnreachableGraphTags, setShowUnreachableGraphTags] = useAtom(showUnreachableGraphTagsState);
  const [showGraphReferenceIndicators, setShowGraphReferenceIndicators] = useAtom(showGraphReferenceIndicatorsState);

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
            helperMessage="Marks graphs that are not reachable from the project's Main Graph."
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
            helperMessage="Shows which graphs directly reference the currently open graph."
            className="settings-toggle-field"
          />
        )}
      </Field>
    </div>
  );
};
