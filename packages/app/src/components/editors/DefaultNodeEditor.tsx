import { type FC, useEffect, useState } from 'react';
import { type ChartNode, type EditorDefinition } from '@valerypopoff/rivet2-core';
import { css } from '@emotion/react';
import { type SharedEditorProps } from './SharedEditorProps';
import { DefaultNodeEditorField } from './DefaultNodeEditorField';
import { useGetRivetUIContext } from '../../hooks/useGetRivetUIContext';
import { useProjectNodeRegistry } from '../../hooks/useProjectNodeRegistry';
import { produce } from 'immer';
import { handleError } from '../../utils/errorHandling.js';
import { getCodeEditorDataKey, getEditorListKey, getEditorRenderRows } from './editorUtils';
import { CodeEditorAiAssistBridge, GenericCodeEditorAiAssist } from './CodeEditorAiAssist';

const AI_ASSIST_TARGET_DATA_KEYS: Record<string, string> = {
  CodeNodeAIAssist: 'code',
  ExtractRegexNodeAiAssist: 'regex',
  GptFunctionNodeJsonSchemaAiAssist: 'schema',
  ObjectNodeAiAssist: 'jsonTemplate',
  PromptNodeAiAssist: 'promptText',
  TextNodeAiAssist: 'text',
};

function getAiAssistTargetDataKey(editor: EditorDefinition<ChartNode>): string | undefined {
  return editor.type === 'custom' ? AI_ASSIST_TARGET_DATA_KEYS[editor.customEditorId] : undefined;
}

export const defaultEditorContainerStyles = css`
  --node-editor-row-gap: calc(18px * var(--ui-font-scale));
  --node-editor-side-control-gap: calc(16px * var(--ui-font-scale));
  --node-editor-label-gap: calc(8px * var(--ui-font-scale));
  --node-editor-label-helper-gap: calc(2px * var(--ui-font-scale));
  --node-editor-helper-control-gap: 0.4em;
  --node-editor-code-helper-gap: calc(10px * var(--ui-font-scale));
  --node-editor-toggle-gap: calc(8px * var(--ui-font-scale));

  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  align-content: start;
  gap: 0;
  flex: 1 1 auto;
  min-height: 0;

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .row > :first-child {
    margin-top: 0 !important;
  }

  .row.custom > :first-child > :first-child {
    margin-top: 0 !important;
  }

  > .row:not(:last-child),
  > .node-editor-code-ai-pair:not(:last-child),
  > .inline-editor-row:not(:last-child) {
    margin-bottom: var(--node-editor-row-gap);
  }

  .row.has-side-control {
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--node-editor-side-control-gap);
  }

  .use-input-toggle {
    align-self: end;
    margin-bottom: calc(4px * var(--ui-font-scale));
    display: flex;
    align-items: flex-start;
  }

  .row.code .use-input-toggle {
    align-self: start;
    margin-top: calc(36px * var(--ui-font-scale));
    margin-bottom: 0;
  }

  .use-input-toggle-button {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--grey-darkish);
    border-radius: 16px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 8px;
    }
    background: var(--grey-darkest);
    color: var(--foreground-muted);
    cursor: pointer;
    transition:
      background-color 0.15s ease-out,
      border-color 0.15s ease-out,
      color 0.15s ease-out;
  }

  .use-input-toggle-button:focus {
    outline: none;
  }

  .use-input-toggle-button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .use-input-toggle-button:hover:not(:disabled) {
    background: var(--grey-darkerish);
    color: var(--grey-light);
  }

  .use-input-toggle-button.is-active {
    background: var(--primary);
    border-color: var(--primary);
    color: white;
  }

  .use-input-toggle-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .use-input-toggle-button svg {
    width: 18px;
    height: 18px;
  }

  .data-type-selector {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    column-gap: var(--node-editor-side-control-gap);
  }

  .editor-wrapper-wrapper {
    min-height: 0;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .row > :first-child label[id$='-label'],
  .row .editor-wrapper-wrapper > label {
    color: var(--label-color);
    margin-bottom: var(--node-editor-label-gap) !important;
  }

  .row > :first-child:has([aria-live='polite']) label[id$='-label'],
  .row .editor-wrapper-wrapper:has(.node-editor-code-helper) > label {
    margin-bottom: var(--node-editor-label-helper-gap) !important;
  }

  .row [aria-live='polite'] {
    margin-top: 0 !important;
    margin-bottom: var(--node-editor-helper-control-gap) !important;
  }

  .node-editor-code-helper {
    margin-bottom: var(--node-editor-code-helper-gap);
    white-space: pre-line;
  }

  .node-editor-code-helper-after {
    margin-top: 8px;
    margin-bottom: 0;
  }

  .node-editor-code-helper > div {
    margin-block: 0;
  }

  .node-editor-code-helper [aria-live='polite'],
  .node-editor-code-helper-after [aria-live='polite'],
  .labeled-toggle-label [aria-live='polite'] {
    margin-bottom: 0 !important;
  }

  .row.info .editor-wrapper-wrapper > label {
    margin-bottom: var(--node-editor-label-helper-gap) !important;
  }

  .row.info [aria-live='polite'] {
    margin-bottom: 0 !important;
  }

  .node-editor-info-helper > div {
    margin-block: 0;
  }

  .editor-viewport-shell {
    position: relative;
    min-height: 0;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: 10px 10px 8px;
    background-color: var(--grey-darkest);
    border-radius: 16px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 8px;
    }
  }

  .editor-wrapper {
    flex: 1 1 auto;
    min-height: 0;
    background-color: var(--grey-darker);
    border-radius: 12px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 6px;
    }
    overflow: visible;
  }

  .node-editor-code-footer {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    min-height: 34px;
    gap: 12px;
    padding: 8px 2px 0;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-compact);
    line-height: 1;
  }

  .node-editor-code-footer-left {
    display: flex;
    align-items: center;
    justify-self: start;
    min-width: 0;
  }

  .node-editor-code-footer-center {
    justify-self: center;
    min-width: 0;
  }

  .node-editor-code-ai-footer-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--foreground-muted);
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .node-editor-code-ai-footer-button:hover,
  .node-editor-code-ai-footer-button[aria-expanded='true'] {
    background: var(--grey-darkerish);
    color: var(--primary);
  }

  .node-editor-code-ai-footer-button svg {
    width: 16px;
    height: 16px;
  }

  .node-editor-code-font-controls {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    justify-self: end;
    white-space: nowrap;
  }

  .node-editor-code-font-size {
    color: var(--foreground-muted);
  }

  .node-editor-code-font-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--foreground-muted);
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .node-editor-code-font-button:hover:not(:disabled) {
    background: var(--grey-darkerish);
    color: var(--foreground);
  }

  .node-editor-code-font-button:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }

  .node-editor-code-font-button svg {
    width: 14px;
    height: 14px;
  }

  .editor-container {
    height: 100%;
    min-height: 0;
    background-color: var(--grey-darker);
    border-radius: inherit;
    overflow: visible;
  }

  .editor-container .monaco-editor {
    border-radius: inherit;
  }

  .code-editor-loading-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-normal);
  }

  .row.code {
    align-items: start;
  }

  .row.code > :first-child {
    min-width: 0;
  }

  .node-editor-static-code-editor {
    min-height: 500px;
    flex: 1 1 auto;
  }

  .node-editor-static-code-editor .editor-container {
    flex: 1 1 auto;
    min-height: 0;
    border-radius: 12px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 6px;
    }
    overflow: visible;
  }

  .node-editor-code-ai-pair {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .node-editor-code-ai-pair > .row:empty {
    display: none;
  }

  .editor-status-line {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    column-gap: 24px;
    row-gap: 2px;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-compact);
    line-height: 1.4;
    text-align: center;
    white-space: nowrap;
  }

  .editor-spellcheck-status {
    color: var(--foreground-muted);
  }

  .node-editor-code-resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 10px;
    cursor: var(--resize-edge-vertical-cursor);
    background: transparent;
    border-bottom: none;
  }

  .node-editor-code-resize-handle::after {
    content: '';
    position: absolute;
    right: 10px;
    bottom: 3px;
    left: 10px;
    height: 2px;
    background: var(--primary);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .node-editor-code-resize-handle:hover::after,
  .node-editor-code-resize-handle.is-resizing::after {
    opacity: 0.65;
  }

  .row.toggle .toggle-editor-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-block: 0;
  }

  .row.toggle .toggle-editor-control-row {
    display: flex;
    align-items: center;
    gap: var(--node-editor-toggle-gap);
  }

  .row.toggle .toggle-editor-switch,
  .row.toggle .toggle-editor-switch > * {
    margin-left: 0 !important;
  }

  .row.toggle .toggle-editor-switch > label[data-size] {
    margin: 0 0 0 -4px !important;
  }

  .row.toggle .toggle-editor-switch > label[data-size]:has(input:focus:not(:focus-visible)) {
    border-color: transparent !important;
    outline: none !important;
    box-shadow: none !important;
  }

  .row.toggle .toggle-editor-label {
    margin: 0;
    min-width: 75px;
    cursor: pointer;
  }

  .row.toggle .toggle-editor-label label {
    cursor: pointer;
  }

  .row.toggle .toggle-editor-helper {
    margin-left: 0;
  }

  .row.toggle .toggle-editor-helper > div {
    margin: 0;
  }

  .row.toggle .use-input-toggle label:first-child {
    min-width: unset;
  }

  .row.segmented .segmented-choice {
    margin-top: 0;
  }

  .row.segmented .segmented-choice-option:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .inline-editor-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 180px));
    gap: var(--node-editor-row-gap);
    align-items: start;
  }

  .node-editor-color-picker {
    width: min(180px, 100%);
  }

  &.comment-node-editor {
    padding-top: 45px;
  }
`;

const NodeCodeEditorWithAiAssist: FC<
  Omit<SharedEditorProps, 'isDisabled'> & {
    aiAssistEditor: EditorDefinition<ChartNode>;
    aiAssistIndex: number;
    codeEditor: EditorDefinition<ChartNode>;
    codeEditorIndex: number;
    onClose?: () => void;
    onRefreshEditors: () => void;
  }
> = ({
  node,
  onChange,
  isReadonly,
  onClose,
  onRefreshEditors,
  aiAssistEditor,
  aiAssistIndex,
  codeEditor,
  codeEditorIndex,
}) => {
  return (
    <CodeEditorAiAssistBridge
      codeEditor={(footerLeftAction) => (
        <DefaultNodeEditorField
          node={node}
          onChange={onChange}
          editor={codeEditor}
          editorKey={getEditorListKey(codeEditor, codeEditorIndex)}
          isReadonly={isReadonly}
          isDisabled={codeEditor.disableIf?.(node.data) ?? false}
          onClose={onClose}
          onRefreshEditors={onRefreshEditors}
          codeEditorFooterLeft={footerLeftAction}
        />
      )}
      aiAssist={
        <DefaultNodeEditorField
          node={node}
          onChange={onChange}
          editor={aiAssistEditor}
          editorKey={getEditorListKey(aiAssistEditor, aiAssistIndex)}
          isReadonly={isReadonly}
          isDisabled={aiAssistEditor.disableIf?.(node.data) ?? false}
          onClose={onClose}
          onRefreshEditors={onRefreshEditors}
        />
      }
    />
  );
};

const NodeCodeEditorWithGenericAiAssist: FC<
  Omit<SharedEditorProps, 'isDisabled'> & {
    codeEditor: Extract<EditorDefinition<ChartNode>, { type: 'code' }>;
    codeEditorIndex: number;
    onClose?: () => void;
    onRefreshEditors: () => void;
  }
> = ({ node, onChange, isReadonly, onClose, onRefreshEditors, codeEditor, codeEditorIndex }) => {
  const isDisabled = codeEditor.disableIf?.(node.data) ?? false;

  return (
    <CodeEditorAiAssistBridge
      codeEditor={(footerLeftAction) => (
        <DefaultNodeEditorField
          node={node}
          onChange={onChange}
          editor={codeEditor}
          editorKey={getEditorListKey(codeEditor, codeEditorIndex)}
          isReadonly={isReadonly}
          isDisabled={isDisabled}
          onClose={onClose}
          onRefreshEditors={onRefreshEditors}
          codeEditorFooterLeft={footerLeftAction}
        />
      )}
      aiAssist={
        <GenericCodeEditorAiAssist
          node={node}
          onChange={onChange}
          isReadonly={isReadonly}
          isDisabled={isDisabled}
          onClose={onClose}
          onRefreshEditors={onRefreshEditors}
          codeEditor={codeEditor}
        />
      }
    />
  );
};

export const DefaultNodeEditor: FC<
  Omit<SharedEditorProps, 'isDisabled'> & {
    onClose?: () => void;
  }
> = ({ node, onChange, isReadonly, onClose }) => {
  const editorLoadKey = `${node.id}:${node.type}`;
  const [editorState, setEditorState] = useState<{
    editorLoadKey: string;
    editors: EditorDefinition<ChartNode>[];
  }>();
  const [editorRefreshNonce, setEditorRefreshNonce] = useState(0);

  const getUIContext = useGetRivetUIContext();
  const projectNodeRegistry = useProjectNodeRegistry();
  const refreshEditors = () => setEditorRefreshNonce((value) => value + 1);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const dynamicImpl = projectNodeRegistry.createDynamicImpl(node);

        let loadedEditors = await dynamicImpl.getEditors(await getUIContext({ node }));

        loadedEditors = produce(loadedEditors, (draft) => {
          const autoFocused = draft.find((e) => e.autoFocus);
          if (!autoFocused) {
            const firstStringOrCodeEditor = draft.find(
              (e) =>
                e.type === 'string' ||
                e.type === 'code' ||
                e.type === 'number' ||
                e.type === 'dropdown' ||
                e.type === 'anyData',
            );
            if (firstStringOrCodeEditor) {
              firstStringOrCodeEditor.autoFocus = true;
            }
          }
        });

        if (!cancelled) {
          setEditorState({ editorLoadKey, editors: loadedEditors });
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        handleError(err, 'Failed to load editors for node', {
          metadata: {
            nodeId: node.id,
            nodeType: node.type,
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editorLoadKey, editorRefreshNonce, getUIContext, node, projectNodeRegistry]);

  const editors = editorState?.editorLoadKey === editorLoadKey ? editorState.editors : [];
  const aiAssistByTargetDataKey = new Map<string, { editor: EditorDefinition<ChartNode>; index: number }>();
  const pairedAiAssistIndexes = new Set<number>();

  editors.forEach((editor, index) => {
    const targetDataKey = getAiAssistTargetDataKey(editor);

    if (targetDataKey && !aiAssistByTargetDataKey.has(targetDataKey)) {
      aiAssistByTargetDataKey.set(targetDataKey, { editor, index });
    }
  });

  editors.forEach((editor) => {
    const dataKey = getCodeEditorDataKey(editor);
    const aiAssistEntry = dataKey ? aiAssistByTargetDataKey.get(dataKey) : undefined;

    if (aiAssistEntry) {
      pairedAiAssistIndexes.add(aiAssistEntry.index);
    }
  });

  const renderEditorField = (editor: EditorDefinition<ChartNode>, index: number) => {
    const isDisabled = editor.disableIf?.(node.data) ?? false;
    const editorKey = getEditorListKey(editor, index);

    return (
      <DefaultNodeEditorField
        key={editorKey}
        node={node}
        onChange={onChange}
        editor={editor}
        editorKey={editorKey}
        isReadonly={isReadonly}
        isDisabled={isDisabled}
        onClose={onClose}
        onRefreshEditors={refreshEditors}
      />
    );
  };

  return (
    <div css={defaultEditorContainerStyles} className={node.type === 'comment' ? 'comment-node-editor' : undefined}>
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

        if (pairedAiAssistIndexes.has(row.index)) {
          return null;
        }

        const dataKey = getCodeEditorDataKey(row.editor);
        const aiAssistEntry = dataKey ? aiAssistByTargetDataKey.get(dataKey) : undefined;

        if (aiAssistEntry) {
          return (
            <NodeCodeEditorWithAiAssist
              key={`${row.key}:${getEditorListKey(aiAssistEntry.editor, aiAssistEntry.index)}`}
              node={node}
              onChange={onChange}
              isReadonly={isReadonly}
              onClose={onClose}
              onRefreshEditors={refreshEditors}
              codeEditor={row.editor}
              codeEditorIndex={row.index}
              aiAssistEditor={aiAssistEntry.editor}
              aiAssistIndex={aiAssistEntry.index}
            />
          );
        }

        if (row.editor.type === 'code') {
          return (
            <NodeCodeEditorWithGenericAiAssist
              key={`${row.key}:generic-ai-assist`}
              node={node}
              onChange={onChange}
              isReadonly={isReadonly}
              onClose={onClose}
              onRefreshEditors={refreshEditors}
              codeEditor={row.editor}
              codeEditorIndex={row.index}
            />
          );
        }

        return renderEditorField(row.editor, row.index);
      })}
    </div>
  );
};
