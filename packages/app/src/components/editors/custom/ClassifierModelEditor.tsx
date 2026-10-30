import { css } from '@emotion/react';
import {
  classifierProviders,
  type ChartNode,
  type ClassifierProvider,
  type CustomEditorDefinition,
} from '@valerypopoff/rivet2-core';
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

type ClassifierModelEditorProps = SharedEditorProps & { editor: CustomEditorDefinition<ChartNode> };

export const ClassifierModelEditor: FC<ClassifierModelEditorProps> = (props) => {
  const providerId = (props.node.data as { provider?: string }).provider;
  const provider = classifierProviders.find(({ id }) => id === providerId) ?? classifierProviders[0]!;
  // Provider changes retire transient editing intent, while saved model names remain intact.
  return <ClassifierModelFields {...props} provider={provider} key={JSON.stringify([props.node.id, provider.id])} />;
};

const ClassifierModelFields: FC<ClassifierModelEditorProps & { provider: ClassifierProvider }> = ({
  node,
  onChange,
  isDisabled,
  isReadonly,
  onClose,
  editor,
  provider,
}) => {
  const models = provider.modelOptions ?? [{ value: provider.defaultModel, label: provider.defaultModel }];
  const model = (node.data as { model?: string }).model ?? '';
  const modelId = model.trim();
  const [editingCustom, setEditingCustom] = useState(false);
  const isCustom = editingCustom || (modelId !== '' && !models.some(({ value }) => value === modelId));
  const changeData = useNodeEditorDataChange(node, onChange);
  const options = [...models, { value: CUSTOM_MODEL, label: 'Custom model…' }];
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
        value={isCustom ? CUSTOM_MODEL : modelId || provider.defaultModel}
        options={options}
        helperMessage={provider.modelHelp}
        isDisabled={isDisabled}
        isReadonly={isReadonly}
        onChange={(value) => {
          if (isDisabled || isReadonly || value === undefined) return;
          if (value === CUSTOM_MODEL) setEditingCustom(true);
          else {
            setEditingCustom(false);
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
              setEditingCustom(true);
              changeData('model', value ?? '');
            }
          }}
        />
      )}
    </div>
  );
};
