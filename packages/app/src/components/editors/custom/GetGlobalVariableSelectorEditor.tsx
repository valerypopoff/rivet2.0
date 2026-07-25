import Select from '@atlaskit/select';
import type { ChartNode, CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { type FC, useMemo, useState } from 'react';
import { graphState, projectState } from '../editorWorkflowState.js';
import type { SharedEditorProps } from '../SharedEditorProps';
import { getGlobalVariableOptions } from './globalVariableOptions.js';

type Props = SharedEditorProps & {
  editor: CustomEditorDefinition<ChartNode>;
};

export const GetGlobalVariableSelectorEditor: FC<Props> = ({ node, onChange, isReadonly, isDisabled, editor }) => {
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const data = node.data as Record<string, unknown>;
  const [searchText, setSearchText] = useState('');
  const options = useMemo(() => getGlobalVariableOptions(project, graph), [graph, project]);

  return (
    <Select
      inputId="global-variable-search"
      aria-label={editor.label}
      options={options}
      value={null}
      inputValue={searchText}
      placeholder="Search global variables..."
      autoFocus={editor.autoFocus}
      isDisabled={isReadonly || isDisabled}
      noOptionsMessage={({ inputValue }) =>
        inputValue ? 'No matching static global variables.' : 'No static global variables found.'
      }
      onInputChange={(newValue, actionMeta) => {
        if (actionMeta.action === 'input-change') {
          setSearchText(newValue);
        }
      }}
      onChange={(selected) => {
        if (selected == null) {
          return;
        }

        setSearchText('');
        onChange({
          ...node,
          data: {
            ...data,
            id: selected.value,
          },
        });
      }}
    />
  );
};
