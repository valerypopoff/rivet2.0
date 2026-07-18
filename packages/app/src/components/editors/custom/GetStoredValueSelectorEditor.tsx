import Select from '@atlaskit/select';
import type { ChartNode, CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { type FC, useMemo, useState } from 'react';
import { graphState } from '../../../state/graph.js';
import { projectState } from '../../../state/savedGraphs.js';
import type { SharedEditorProps } from '../SharedEditorProps';
import { getStoredValueOptions } from './storedValueOptions.js';

type Props = SharedEditorProps & { editor: CustomEditorDefinition<ChartNode> };

export const GetStoredValueSelectorEditor: FC<Props> = ({ node, onChange, isReadonly, isDisabled, editor }) => {
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const data = node.data as Record<string, unknown>;
  const [searchText, setSearchText] = useState('');
  const options = useMemo(() => getStoredValueOptions(project, graph), [graph, project]);

  return (
    <Select
      inputId="stored-value-search"
      aria-label={editor.label}
      options={options}
      value={null}
      inputValue={searchText}
      placeholder="Search stored values..."
      autoFocus={editor.autoFocus}
      isDisabled={isReadonly || isDisabled}
      noOptionsMessage={({ inputValue }) =>
        inputValue ? 'No matching static stored-value keys.' : 'No static stored-value keys found.'
      }
      onInputChange={(newValue, actionMeta) => {
        if (actionMeta.action === 'input-change') setSearchText(newValue);
      }}
      onChange={(selected) => {
        if (!selected) return;
        setSearchText('');
        onChange({ ...node, data: { ...data, key: selected.value, useKeyInput: false } });
      }}
    />
  );
};
