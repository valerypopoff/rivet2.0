import { css } from '@emotion/react';
import { classifierProviders, type ChartNode, type CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { useState, type FC } from 'react';
import { useNodeEditorDataChange } from '../../nodeEditor/NodeEditorSessionContext.js';
import { DropdownEditor } from '../DropdownEditor.js';
import { StringEditor } from '../StringEditor.js';
import type { SharedEditorProps } from '../SharedEditorProps.js';

const CUSTOM_MODEL = '__rivet_custom_model__'; // UI value only; never saved as the model.
const styles = css`
  display: grid;
  gap: 8px;
  width: 100%;
`;

export const ClassifierModelEditor: FC<SharedEditorProps & { editor: CustomEditorDefinition<ChartNode> }> = ({
  node,
  onChange,
  isDisabled,
  isReadonly,
  onClose,
  editor,
}) => {
  const data = node.data as { provider?: string; model?: string };
  const provider = classifierProviders.find(({ id }) => id === data.provider) ?? classifierProviders[0]!;
  const models = provider.modelOptions ?? [{ value: provider.defaultModel, label: provider.defaultModel }];
  const model = data.model ?? '';
  const scope = JSON.stringify([node.id, provider.id]);
  const [customScope, setCustomScope] = useState<string>();
  const isCustom =
    customScope === scope || (model.trim() !== '' && !models.some(({ value }) => value === model.trim()));
  const changeData = useNodeEditorDataChange(node, onChange);
  const options = [
    { value: '', label: `Default (${provider.defaultModel})` },
    ...models,
    { value: CUSTOM_MODEL, label: 'Custom model…' },
  ];
  return (
    <div
      css={styles}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (
          event.key === 'Escape' &&
          target.getAttribute('role') === 'combobox' &&
          target.getAttribute('aria-expanded') === 'false'
        ) {
          event.preventDefault();
          event.stopPropagation();
          onClose?.();
        }
      }}
    >
      <DropdownEditor
        label={editor.label}
        name="classifierModel"
        value={isCustom ? CUSTOM_MODEL : model.trim()}
        options={options}
        helperMessage={provider.modelHelp}
        isDisabled={isDisabled}
        isReadonly={isReadonly}
        onChange={(value) => {
          if (isDisabled || isReadonly || value === undefined) return;
          if (value === CUSTOM_MODEL) setCustomScope(scope);
          else {
            setCustomScope(undefined);
            changeData('model', value);
          }
        }}
      />
      {isCustom && (
        <StringEditor
          label="Custom model"
          name="classifierCustomModel"
          value={model}
          placeholder={provider.defaultModel}
          isDisabled={isDisabled}
          isReadonly={isReadonly}
          onClose={onClose}
          onChange={(value) => {
            if (!isDisabled && !isReadonly) {
              // An unlisted saved value also enters Custom implicitly. Keep
              // that editing intent when it becomes empty or matches a known ID.
              setCustomScope(scope);
              changeData('model', value ?? '');
            }
          }}
        />
      )}
    </div>
  );
};
