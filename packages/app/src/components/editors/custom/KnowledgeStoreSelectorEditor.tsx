import Select from '@atlaskit/select';
import type { ChartNode, CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import type { FC } from 'react';
import { projectState } from '../../../state/savedGraphs.js';
import type { SharedEditorProps } from '../SharedEditorProps.js';

type Props = SharedEditorProps & { editor: CustomEditorDefinition<ChartNode> };

export const KnowledgeStoreSelectorEditor: FC<Props> = ({ node, onChange, isReadonly, isDisabled, editor }) => {
  const project = useAtomValue(projectState);
  const data = node.data as Record<string, unknown>;
  const connectionId = typeof data.connectionId === 'string' ? data.connectionId : '';
  const options = Object.entries(project.metadata.knowledgeStores ?? {})
    .map(([value, definition]) => ({ value, label: definition.displayName }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const value = options.find((option) => option.value === connectionId) ?? null;

  return (
    <Select
      inputId="knowledge-store-selector"
      aria-label={editor.label}
      options={options}
      value={value}
      placeholder={options.length ? 'Select a knowledge store...' : 'Configure a knowledge store in Project Settings'}
      isDisabled={isReadonly || isDisabled}
      noOptionsMessage={() => 'No knowledge stores are configured for this project.'}
      onChange={(selected) => {
        onChange({ ...node, data: { ...data, connectionId: selected?.value ?? '' } });
      }}
    />
  );
};
