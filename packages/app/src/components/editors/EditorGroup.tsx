import { type ChartNode, type EditorDefinitionGroup } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { css } from '@emotion/react';
// eslint-disable-next-line import/no-cycle
import { DefaultNodeEditorField } from './DefaultNodeEditorField';
import { getEditorListKey, getEditorRenderRows, getHelperMessage } from './editorUtils';
import { HelperMessage } from '@atlaskit/form';
import { ToggleEditor } from './ToggleEditor';
import { LabeledToggle } from '../LabeledToggle';
import { useAtom } from 'jotai';
import { nodeEditorGroupOpenState } from '../../state/ui.js';
import { resolveNodeEditorGroupOpen, setNodeEditorGroupOpen } from '../../utils/nodeEditorGroupState.js';
import { CodeEditorAiAssistBridge, GenericCodeEditorAiAssist } from './CodeEditorAiAssist';
import { CollapsiblePanel, collapsiblePanelStyles } from '../CollapsiblePanel.js';

const styles = css`
  --editor-group-padding-x: calc(16px * var(--ui-font-scale));
  --editor-group-padding-y: calc(16px * var(--ui-font-scale));
  --editor-group-padding-bottom: calc(18px * var(--ui-font-scale));

  grid-column: span 2;
  display: flex;
  flex-direction: column;
  align-items: stretch;

  .collapsible-panel-toggle-with-switch {
    justify-content: flex-start;
    cursor: default;
  }

  .collapsible-panel-toggle-with-switch:hover {
    background: none;
  }

  .editor-group {
    margin-top: 0;
    padding: var(--editor-group-padding-y) var(--editor-group-padding-x) var(--editor-group-padding-bottom);

    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    align-content: start;
    gap: 0;
    flex: 1 1 auto;
    min-height: 0;
  }

  .editor-group > .row:not(:last-child),
  .editor-group > .node-editor-code-ai-pair:not(:last-child),
  .editor-group > .inline-editor-row:not(:last-child) {
    margin-bottom: var(--node-editor-row-gap, calc(24px * var(--ui-font-scale)));
  }
`;

const ToggleHeader: FC<{
  isChecked: boolean;
  isDisabled: boolean;
  label: string;
  toggleId: string;
  helperMessage?: string;
  onChange: (value: boolean) => void;
}> = ({ isChecked, isDisabled, label, toggleId, helperMessage, onChange }) => (
  <div className="collapsible-panel-toggle-area">
    <LabeledToggle
      id={toggleId}
      isChecked={isChecked}
      isDisabled={isDisabled}
      onChange={onChange}
      label={label}
      className="collapsible-panel-toggle collapsible-panel-toggle-with-switch"
      switchClassName="collapsible-panel-toggle-switch"
      labelClassName="collapsible-panel-toggle-label"
      helperMessage={helperMessage}
    />
  </div>
);

export const EditorGroup: FC<
  SharedEditorProps & {
    editor: EditorDefinitionGroup<ChartNode>;
    editorKey: string;
  }
> = ({ editor, editorKey, ...sharedProps }) => {
  const { editors, label, hideIf, defaultOpen = false, toggleDataKey } = editor;
  const [nodeEditorGroupOpen, setNodeEditorGroupOpenState] = useAtom(nodeEditorGroupOpenState);

  if (hideIf?.(sharedProps.node.data)) {
    return null;
  }

  const helperMessage = getHelperMessage(editor, sharedProps.node.data);
  const data = sharedProps.node.data as Record<string, unknown>;
  const isToggleGroupEnabled = toggleDataKey ? Boolean(data[toggleDataKey]) : false;
  const groupKey = editorKey;
  const isOpen = resolveNodeEditorGroupOpen({
    state: nodeEditorGroupOpen,
    nodeType: sharedProps.node.type,
    groupKey,
    defaultOpen,
  });
  const setOpen = (nextOpen: boolean) => {
    setNodeEditorGroupOpenState((state) =>
      setNodeEditorGroupOpen(state, {
        nodeType: sharedProps.node.type,
        groupKey,
        isOpen: nextOpen,
      }),
    );
  };
  const renderEditorField = (editor: (typeof editors)[number], index: number) => {
    const isDisabled = editor.disableIf?.(sharedProps.node.data) || sharedProps.isDisabled;
    const childEditorKey = `${editorKey}/${getEditorListKey(editor, index)}`;

    if (editor.type === 'code') {
      return (
        <CodeEditorAiAssistBridge
          key={childEditorKey}
          codeEditor={(footerLeftAction) => (
            <DefaultNodeEditorField
              {...sharedProps}
              editor={editor}
              editorKey={childEditorKey}
              isDisabled={isDisabled}
              codeEditorFooterLeft={footerLeftAction}
            />
          )}
          aiAssist={<GenericCodeEditorAiAssist {...sharedProps} isDisabled={isDisabled} codeEditor={editor} />}
        />
      );
    }

    return (
      <DefaultNodeEditorField
        key={childEditorKey}
        {...sharedProps}
        editor={editor}
        editorKey={childEditorKey}
        isDisabled={isDisabled}
      />
    );
  };
  const renderedContent = (
    <div className="editor-group">
      {getEditorRenderRows(editors).map((row) => {
        if (row.type === 'inline') {
          return (
            <div className="inline-editor-row" key={row.key}>
              {row.editors.map((inlineEditor, inlineIndex) =>
                renderEditorField(inlineEditor, row.startIndex + inlineIndex),
              )}
            </div>
          );
        }

        return renderEditorField(row.editor, row.index);
      })}
    </div>
  );

  if (toggleDataKey) {
    const toggleId = `editor-group-toggle-${sharedProps.node.id}-${String(toggleDataKey)}`;
    const setToggleGroupEnabled = (value: boolean | undefined) =>
      sharedProps.onChange({
        ...sharedProps.node,
        data: {
          ...data,
          [toggleDataKey]: value,
        },
      });

    if (!isToggleGroupEnabled) {
      return (
        <div className="row toggle">
          <ToggleEditor
            value={data[toggleDataKey] as boolean | undefined}
            isReadonly={sharedProps.isReadonly}
            isDisabled={sharedProps.isDisabled}
            onChange={setToggleGroupEnabled}
            label={label}
            name={String(toggleDataKey)}
            helperMessage={helperMessage}
          />
        </div>
      );
    }

    return (
      <div css={[collapsiblePanelStyles, styles]}>
        <div className="collapsible-panel-toggle-container open">
          <ToggleHeader
            isChecked={isToggleGroupEnabled}
            isDisabled={sharedProps.isReadonly || sharedProps.isDisabled}
            label={label}
            toggleId={toggleId}
            helperMessage={helperMessage}
            onChange={setToggleGroupEnabled}
          />
        </div>
        {isToggleGroupEnabled && <div className="collapsible-panel-static-content">{renderedContent}</div>}
      </div>
    );
  }

  return (
    <div css={styles}>
      <CollapsiblePanel
        open={isOpen}
        onToggle={() => setOpen(!isOpen)}
        label={label}
        helper={helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
      >
        {renderedContent}
      </CollapsiblePanel>
    </div>
  );
};
