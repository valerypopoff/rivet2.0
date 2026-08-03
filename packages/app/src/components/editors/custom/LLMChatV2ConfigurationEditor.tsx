import Button from '@atlaskit/button';
import { Field } from '@atlaskit/form';
import { css } from '@emotion/react';
import { type ChartNode, type CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { useExtractLLMChatProfileCommand } from '../../../commands/extractLLMChatProfileCommand.js';
import { useProjectWorkspaceTarget } from '../../../hooks/useProjectWorkspaceTarget.js';
import { FieldHelperMessage } from '../../FieldHelperMessage.js';
import { Tooltip } from '../../Tooltip.js';
import { SegmentedEditor } from '../SegmentedEditor.js';
import { type SharedEditorProps } from '../SharedEditorProps.js';

const styles = css`
  display: flex;
  align-items: center;
  gap: calc(8px * var(--ui-font-scale));
  min-height: calc(32px * var(--ui-font-scale));
  width: 100%;
  min-width: 0;

  .llm-configuration-mode {
    flex: 0 0 auto;
    width: max-content;
    min-width: max-content;
  }

  .llm-configuration-mode .segmented-editor-control,
  .llm-configuration-mode .segmented-choice {
    width: max-content;
    max-width: none;
  }

  .llm-configuration-export {
    flex: 0 0 auto;
    margin-left: auto;
    margin-bottom: calc(1px * var(--ui-font-scale));
    white-space: nowrap;
  }
`;

type Props = SharedEditorProps & {
  editor: CustomEditorDefinition<ChartNode>;
};

export const LLMChatV2ConfigurationEditor: FC<Props> = ({ editor, isDisabled, isReadonly, node, onChange }) => {
  const extractLLMChatProfile = useExtractLLMChatProfileCommand();
  const workspaceTarget = useProjectWorkspaceTarget();
  const data = node.data as { configurationMode?: 'inline' | 'profile' };
  const usesProfile = data.configurationMode === 'profile';
  const canExportToProfile = !usesProfile && workspaceTarget?.type !== 'nodeLibrary';
  const isControlDisabled = isReadonly || isDisabled;
  const exportTooltip =
    'Creates an LLM Profile from these Inline settings, moves configuration input connections to it, connects it to this LLM Chat, and switches this node to From profile.';
  const helperMessage =
    'Inline keeps provider and model settings in this node. From profile adds an LLM Profile input so reusable configurations can be switched without changing Chat behavior.';

  return (
    <Field name="configurationMode" label={editor.label} isDisabled={isControlDisabled}>
      {() => (
        <div>
          <FieldHelperMessage>{helperMessage}</FieldHelperMessage>
          <div css={styles} className="llm-configuration-row">
            <div className="llm-configuration-mode">
              <SegmentedEditor
                value={data.configurationMode}
                onChange={(configurationMode) =>
                  onChange({
                    ...node,
                    data: {
                      ...(node.data as Record<string, unknown>),
                      configurationMode,
                    },
                  })
                }
                isReadonly={isReadonly}
                isDisabled={isDisabled}
                label=""
                ariaLabel="LLM configuration source"
                name="configurationMode"
                options={[
                  { value: 'inline', label: 'Inline' },
                  { value: 'profile', label: 'From profile' },
                ]}
                defaultValue="inline"
                allowOptionWrap={false}
              />
            </div>
            {canExportToProfile && (
              <Tooltip tag="span" className="llm-configuration-export" content={exportTooltip}>
                <Button
                  appearance="subtle"
                  isDisabled={isControlDisabled}
                  onClick={() => extractLLMChatProfile({ nodeId: node.id })}
                >
                  Export LLM settings to profile node
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      )}
    </Field>
  );
};
