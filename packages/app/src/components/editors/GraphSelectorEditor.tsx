import { type GraphSelectorEditorDefinition, type ChartNode, type GraphId } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { Field, HelperMessage } from '@atlaskit/form';
import Select from '@atlaskit/select';
import { useAtomValue } from 'jotai';
import { projectState } from '../../state/savedGraphs';
import { getHelperMessage } from './editorUtils';
import { getProjectGraphSelectorOptions } from '../../utils/graphSelectorOptions';

export const DefaultGraphSelectorEditor: FC<
  SharedEditorProps & {
    editor: GraphSelectorEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);

  return (
    <GraphSelector
      value={data[editor.dataKey] as GraphId | undefined}
      isReadonly={isReadonly || isDisabled}
      onChange={(selected) =>
        onChange({
          ...node,
          data: {
            ...data,
            [editor.dataKey]: selected,
          },
        })
      }
      label={editor.label}
      name={editor.dataKey}
      helperMessage={helperMessage}
    />
  );
};

export const GraphSelector: FC<{
  value: GraphId | undefined;
  name: string;
  label: string;
  isReadonly: boolean;
  onChange?: (selected: GraphId) => void;
  helperMessage?: string;
}> = ({ value, isReadonly, onChange, label, name, helperMessage }) => {
  return (
    <Field name={name} label={label} isDisabled={isReadonly}>
      {({ fieldProps }) => (
        <>
          {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
          <GraphSelectorSelect {...fieldProps} value={value} isReadonly={isReadonly} onChange={onChange} />
        </>
      )}
    </Field>
  );
};

export const GraphSelectorSelect: FC<{
  value: GraphId | undefined;
  isReadonly?: boolean;
  onChange?: (selected: GraphId) => void;
  ariaLabel?: string;
  className?: string;
  includeMissingSelectedGraph?: boolean;
}> = ({ value, isReadonly, onChange, ariaLabel, className, includeMissingSelectedGraph = false }) => {
  const project = useAtomValue(projectState);
  const graphOptions = getProjectGraphSelectorOptions(project.graphs, {
    includeMissingSelectedGraph,
    selectedGraphId: value,
  });

  const selectedOption = graphOptions.find((option) => option.value === value);

  return (
    <Select
      aria-label={ariaLabel}
      className={className}
      isDisabled={isReadonly}
      isSearchable
      options={graphOptions}
      value={selectedOption ?? null}
      onChange={(selected) => {
        if (selected) {
          onChange?.(selected.value);
        }
      }}
      placeholder="Select Graph..."
    />
  );
};
