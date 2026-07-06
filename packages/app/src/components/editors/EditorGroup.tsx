import { type ChartNode, type EditorDefinitionGroup } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { css } from '@emotion/react';
// eslint-disable-next-line import/no-cycle
import { DefaultNodeEditorField } from './DefaultNodeEditorField';
import Collapsible from 'react-collapsible';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronUpIcon from 'majesticons/line/chevron-up-line.svg?react';
import { getEditorListKey, getEditorRenderRows, getHelperMessage } from './editorUtils';
import { HelperMessage } from '@atlaskit/form';
import { ToggleEditor } from './ToggleEditor';
import { LabeledToggle } from '../LabeledToggle';
import { useAtom } from 'jotai';
import { nodeEditorGroupOpenState } from '../../state/ui.js';
import { resolveNodeEditorGroupOpen, setNodeEditorGroupOpen } from '../../utils/nodeEditorGroupState.js';
import { CodeEditorAiAssistBridge, GenericCodeEditorAiAssist } from './CodeEditorAiAssist';

const styles = css`
  --editor-group-radius: calc(16px * var(--ui-font-scale));
  --editor-group-toggle-radius: calc(8px * var(--ui-font-scale));
  --editor-group-padding-x: calc(16px * var(--ui-font-scale));
  --editor-group-padding-y: calc(16px * var(--ui-font-scale));
  --editor-group-padding-bottom: calc(18px * var(--ui-font-scale));
  --editor-group-toggle-padding-y: calc(8px * var(--ui-font-scale));
  --editor-group-toggle-icon-size: calc(24px * var(--ui-font-scale));

  @supports not (corner-shape: squircle) {
    --editor-group-radius: calc(8px * var(--ui-font-scale));
    --editor-group-toggle-radius: calc(4px * var(--ui-font-scale));
  }

  grid-column: span 2;
  display: flex;
  flex-direction: column;
  align-items: stretch;

  > .editor-group-toggle-container,
  > .Collapsible .editor-group-toggle-container {
    display: flex;
    flex-direction: column;
    padding-left: var(--editor-group-padding-x);
    padding-right: var(--editor-group-padding-x);
    border: 1px solid var(--settings-collapsible-border);
    border-radius: var(--editor-group-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-header-bg);
  }

  > .editor-group-toggle-container.open,
  > .Collapsible > .editor-group-toggle-container.open {
    border-bottom: none;
    border-radius: var(--editor-group-radius) var(--editor-group-radius) 0 0;
    corner-shape: squircle;
  }

  > .editor-group-toggle-container.open + .editor-group-static-content,
  > .Collapsible > .editor-group-toggle-container.open + .Collapsible__contentOuter {
    border: 1px solid var(--settings-collapsible-border);
    border-top: none;
    border-radius: 0 0 var(--editor-group-radius) var(--editor-group-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-body-bg);
  }

  .editor-group-toggle-area {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .editor-group-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--editor-group-toggle-padding-y) var(--editor-group-padding-x);
    margin: 0 calc(-1 * var(--editor-group-padding-x));
    border: none;
    background: none;
    cursor: pointer;
    outline: none;
    font-size: var(--ui-font-size-base);
    line-height: 1.25;
    font-weight: 500;
    border-radius: var(--editor-group-toggle-radius);
    corner-shape: squircle;
    transition: background 0.2s ease-out;
    font-family: inherit;
    color: var(--label-color);
    font-weight: var(--label-font-weight);

    .indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--editor-group-toggle-icon-size);
      height: var(--editor-group-toggle-icon-size);
      flex: 0 0 var(--editor-group-toggle-icon-size);
    }

    &:hover {
      background: var(--settings-collapsible-hover-bg);
    }
  }

  .editor-group-toggle-with-switch {
    justify-content: flex-start;
    cursor: default;
  }

  .editor-group-toggle-with-switch:hover {
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

const CollapsibleToggle: FC<{ isOpen?: boolean; label: string; helperMessage?: string }> = ({
  isOpen,
  label,
  helperMessage,
}) => (
  <div className="editor-group-toggle-area">
    <button type="button" className="editor-group-toggle">
      <span className="label">{label}</span>
      <span className="indicator">{isOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
    </button>
    {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
  </div>
);

const ToggleHeader: FC<{
  isChecked: boolean;
  isDisabled: boolean;
  label: string;
  toggleId: string;
  helperMessage?: string;
  onChange: (value: boolean) => void;
}> = ({ isChecked, isDisabled, label, toggleId, helperMessage, onChange }) => (
  <div className="editor-group-toggle-area">
    <LabeledToggle
      id={toggleId}
      isChecked={isChecked}
      isDisabled={isDisabled}
      onChange={onChange}
      label={label}
      className="editor-group-toggle editor-group-toggle-with-switch"
      switchClassName="editor-group-toggle-switch"
      labelClassName="editor-group-toggle-label"
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
          aiAssist={
            <GenericCodeEditorAiAssist
              {...sharedProps}
              isDisabled={isDisabled}
              codeEditor={editor}
            />
          }
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
      <div css={styles}>
        <div className="editor-group-toggle-container open">
          <ToggleHeader
            isChecked={isToggleGroupEnabled}
            isDisabled={sharedProps.isReadonly || sharedProps.isDisabled}
            label={label}
            toggleId={toggleId}
            helperMessage={helperMessage}
            onChange={setToggleGroupEnabled}
          />
        </div>
        {isToggleGroupEnabled && <div className="editor-group-static-content">{renderedContent}</div>}
      </div>
    );
  }

  return (
    <div css={styles}>
      <Collapsible
        open={isOpen}
        handleTriggerClick={() => setOpen(!isOpen)}
        trigger={<CollapsibleToggle label={label} helperMessage={helperMessage} />}
        triggerClassName="editor-group-toggle-container"
        triggerOpenedClassName="editor-group-toggle-container open"
        triggerWhenOpen={<CollapsibleToggle label={label} isOpen helperMessage={helperMessage} />}
        transitionTime={150}
        easing="ease-out"
      >
        {renderedContent}
      </Collapsible>
    </div>
  );
};
