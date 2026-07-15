import { HelperMessage, Label } from '@atlaskit/form';
import { type CodeEditorDefinition, type ChartNode } from '@valerypopoff/rivet2-core';
import { useLatest, useDebounceFn } from 'ahooks';
import { useAtomValue } from 'jotai';
import {
  type FC,
  type MutableRefObject,
  type ReactNode,
  useContext,
  useRef,
  useEffect,
  Suspense,
  useMemo,
  useState,
} from 'react';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import MinusIcon from 'majesticons/line/minus-line.svg?react';
import { type monaco } from '../../utils/monaco';
import { themeState } from '../../state/settings.js';
import { graphMetadataState } from '../../state/graph.js';
import { projectState } from '../../state/savedGraphs.js';
import { LazyCodeEditor } from '../LazyComponents';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage, getPostEditorHelperMessage } from './editorUtils';
import { resolveMonacoDisplayTheme } from '../codeEditorTheme.js';
import { ResizeHandle } from '../ResizeHandle.js';
import { resizeCursorStyles } from '../../utils/resizeCursors.js';
import {
  RESIZABLE_LANGUAGES,
  resolveStaticViewportHeight,
  useNodeEditorCodeViewportHeight,
} from './useNodeEditorCodeViewportHeight.js';
import { getTextEditorStats } from './textEditorStats.js';
import { handleCodeEditorEscape } from './codeEditorEscape.js';
import { lastRunDataState, resolvedGraphSelectionState, selectedProcessPageState } from '../../state/dataFlow.js';
import { getSelectedProcessData } from '../../state/selectors/executionSelectors.js';
import { getCodeNodeErrorLineHighlight, type CodeNodeErrorLineHighlight } from '../nodes/codeNodeOutputUtils.js';
import { type EditorInterpolationSyntax } from '../../utils/monaco/interpolationDiagnostics.js';
import { buildCodeEditorModelCacheKey } from '../../utils/monaco/codeEditorModelCacheKey.js';
import { shouldEnableMarkdownFolding } from '../../utils/monaco/markdownFoldingRanges.js';
import {
  clearCodeEditorSpellcheckMarkers,
  runCodeEditorSpellcheck,
  type SpellcheckResult,
} from '../../utils/monaco/spellcheck.js';
import { JsonStringPreviewAffordance } from '../renderDataValue/JsonStringPreviewAffordance.js';
import {
  isCurrentJsonStringPreviewLiteral,
  type JsonStringPreviewRange,
} from '../renderDataValue/jsonStringPreviewRanges.js';
import { useMultilineEditorFontSize } from '../../hooks/useMultilineEditorFontSize.js';
import {
  MAX_MULTILINE_EDITOR_FONT_SIZE,
  MIN_MULTILINE_EDITOR_FONT_SIZE,
  type MultilineEditorFontSizeCommand,
} from '../../utils/multilineEditorFontSize.js';
import { Tooltip } from '../Tooltip.js';
import { NodeCodeEditorFooterActionContext } from './NodeCodeEditorFooterActionContext.js';
import { validateJsonTemplate } from '../../utils/monaco/jsonTemplateValidation.js';

type CodeEditorDefinitionWithInterpolationSyntax = CodeEditorDefinition<ChartNode> & {
  interpolationSyntax?: EditorInterpolationSyntax;
};

function getErrorLineHighlightKey(highlight: CodeNodeErrorLineHighlight | undefined): string | undefined {
  return highlight ? `${highlight.runKey}:${highlight.line}` : undefined;
}

type SpellcheckStatus =
  | { type: 'checking' }
  | { type: 'done'; result: SpellcheckResult }
  | { type: 'error'; message: string };

type MountedEditorState = {
  editor: monaco.editor.IStandaloneCodeEditor;
  editorMountKey: string;
};

const JSON_TEMPLATE_VALIDITY_DEBOUNCE_MS = 300;

function getSpellcheckStatusMessage(status: SpellcheckStatus | undefined): string | undefined {
  if (!status) {
    return undefined;
  }

  if (status.type === 'checking') {
    return 'Checking spelling...';
  }

  if (status.type === 'error') {
    return status.message;
  }

  const { issueCount, markerCount, reachedLimit } = status.result;

  if (issueCount === 0) {
    return 'No spelling issues found';
  }

  if (reachedLimit) {
    return `${markerCount.toLocaleString()}+ possible spelling issues`;
  }

  const issueLabel = issueCount === 1 ? 'possible spelling issue' : 'possible spelling issues';

  return `${issueCount.toLocaleString()} ${issueLabel}`;
}

function shouldEnableJsonStringPreview(language: string | undefined): boolean {
  return language === 'json';
}

function getJsonTemplateValidityStatus(
  interpolationSyntax: EditorInterpolationSyntax | undefined,
  value: string,
): { type: 'valid' | 'invalid'; label: string } | undefined {
  if (interpolationSyntax !== 'json-template') {
    return undefined;
  }

  return validateJsonTemplate(value).length === 0
    ? { type: 'valid', label: 'Valid JSON template' }
    : { type: 'invalid', label: 'Invalid JSON template' };
}

function getSelectedEditorText(editor: monaco.editor.IStandaloneCodeEditor): string | undefined {
  const model = editor.getModel();
  const selection = editor.getSelection();

  if (!model || !selection || selection.isEmpty()) {
    return undefined;
  }

  return model.getValueInRange(selection);
}

function replaceJsonStringLiteral(
  editor: monaco.editor.IStandaloneCodeEditor | undefined,
  range: JsonStringPreviewRange,
  decodedValue: string,
) {
  const model = editor?.getModel();

  if (!editor || !model) {
    return;
  }

  const start = model.getPositionAt(range.startOffset);
  const end = model.getPositionAt(range.endOffset);
  const modelRange = {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };

  if (!isCurrentJsonStringPreviewLiteral(model.getValueInRange(modelRange), range)) {
    return;
  }

  editor.pushUndoStop();
  editor.executeEdits('json-string-preview-edit', [
    {
      range: modelRange,
      text: JSON.stringify(decodedValue),
      forceMoveMarkers: true,
    },
  ]);
  editor.pushUndoStop();
  editor.focus();
}

const FONT_SIZE_COMMANDS = [
  {
    command: 'decrease' as const,
    label: 'Decrease editor font size',
    icon: <MinusIcon />,
    getDisabled: (fontSize: number) => fontSize <= MIN_MULTILINE_EDITOR_FONT_SIZE,
  },
  {
    command: 'increase' as const,
    label: 'Increase editor font size',
    icon: <PlusIcon />,
    getDisabled: (fontSize: number) => fontSize >= MAX_MULTILINE_EDITOR_FONT_SIZE,
  },
];

const CodeEditorFooter: FC<{
  center: ReactNode;
  left: ReactNode;
  fontSize: number;
  onAdjustFontSize: (command: MultilineEditorFontSizeCommand) => void;
}> = ({ center, left, fontSize, onAdjustFontSize }) => (
  <div className="node-editor-code-footer">
    <div className="node-editor-code-footer-left">{left}</div>
    <div className="node-editor-code-footer-center">{center}</div>
    <div className="node-editor-code-font-controls" aria-label="Editor font size controls">
      <span className="node-editor-code-font-size">Font size: {fontSize}px</span>
      {FONT_SIZE_COMMANDS.map(({ command, label, icon, getDisabled }) => (
        <Tooltip key={command} content={label}>
          <button
            type="button"
            className="node-editor-code-font-button"
            aria-label={label}
            disabled={getDisabled(fontSize)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAdjustFontSize(command)}
          >
            {icon}
          </button>
        </Tooltip>
      ))}
    </div>
  </div>
);

export const DefaultCodeEditor: FC<
  SharedEditorProps & {
    editor: CodeEditorDefinition<ChartNode>;
    footerLeft?: ReactNode;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor: editorDef, onClose, footerLeft }) => {
  const helperMessage = getHelperMessage(editorDef, node.data);
  const postEditorHelperMessage = getPostEditorHelperMessage(editorDef, node.data);
  const nodeLatest = useLatest(node);

  const debouncedOnChange = useDebounceFn<(node: ChartNode) => void>(onChange, { wait: 100 });

  const onEditorChange = (newText: string) => {
    const currentNode = nodeLatest.current;
    if (!currentNode) return;
    debouncedOnChange.run({
      ...currentNode,
      data: {
        ...(currentNode.data as Record<string, unknown> | undefined),
        [editorDef.dataKey]: newText,
      },
    });
  };

  const editorProps: CodeEditorProps = {
    value: (node.data as Record<string, unknown> | undefined)?.[editorDef.dataKey] as string | undefined,
    onChange: onEditorChange,
    isReadonly,
    isDisabled,
    autoFocus: editorDef.autoFocus,
    label: editorDef.label,
    name: editorDef.dataKey,
    helperMessage,
    postEditorHelperMessage,
    onClose,
    language: editorDef.language,
    interpolationSyntax: (editorDef as CodeEditorDefinitionWithInterpolationSyntax).interpolationSyntax,
    theme: editorDef.theme,
    enableFolding: editorDef.enableFolding,
    id: node.id,
    nodeType: node.type,
    defaultHeight: editorDef.height,
    showTextStats: 'showTextStats' in editorDef && editorDef.showTextStats === true,
    footerLeft,
  };

  if ((node.type === 'code' || node.type === 'codeNew') && editorDef.dataKey === 'code') {
    return <CodeEditorWithCodeNodeErrorHighlight node={node} {...editorProps} />;
  }

  return <CodeEditor {...editorProps} />;
};

const CodeEditorWithCodeNodeErrorHighlight: FC<CodeEditorProps & { node: ChartNode }> = ({ node, ...editorProps }) => {
  const runData = useAtomValue(lastRunDataState(node.id));
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);
  const selectedPage = useAtomValue(selectedProcessPageState(node.id));
  const selectedRun = useMemo(
    () => getSelectedProcessData(runData, selectedPage, graphSelectionOptions),
    [graphSelectionOptions, runData, selectedPage],
  );
  const errorLineHighlight = useMemo(() => getCodeNodeErrorLineHighlight(selectedRun), [selectedRun]);

  return <CodeEditor {...editorProps} errorLineHighlight={errorLineHighlight} />;
};

type CodeEditorProps = {
  value: string | undefined;
  onChange: (value: string) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  autoFocus?: boolean;
  label: string;
  name?: string;
  helperMessage?: string;
  postEditorHelperMessage?: string;
  onClose?: () => void;
  theme?: string;
  language?: string;
  interpolationSyntax?: EditorInterpolationSyntax;
  enableFolding?: boolean;
  id?: string;
  nodeType?: string;
  defaultHeight?: number;
  showTextStats?: boolean;
  errorLineHighlight?: CodeNodeErrorLineHighlight;
  footerLeft?: ReactNode;
};

export const CodeEditor: FC<CodeEditorProps> = ({
  value,
  onChange,
  isReadonly,
  isDisabled,
  autoFocus,
  label,
  name,
  helperMessage,
  postEditorHelperMessage,
  onClose,
  theme,
  language,
  interpolationSyntax,
  enableFolding,
  id,
  nodeType,
  defaultHeight,
  showTextStats = false,
  errorLineHighlight,
  footerLeft = null,
}) => {
  const editorInstance = useRef<monaco.editor.IStandaloneCodeEditor>();
  const spellcheckRunId = useRef(0);
  const [displayValue, setDisplayValue] = useState(value ?? '');
  const [dismissedErrorLineHighlightKey, setDismissedErrorLineHighlightKey] = useState<string>();
  const [mountedEditorState, setMountedEditorState] = useState<MountedEditorState>();
  const [spellcheckStatus, setSpellcheckStatus] = useState<SpellcheckStatus>();
  const { fontSize, adjustFontSize } = useMultilineEditorFontSize();
  const footerActionBridge = useContext(NodeCodeEditorFooterActionContext);

  const onChangeLatest = useLatest(onChange);
  const isEditorReadOnly = isReadonly || isDisabled;
  const appTheme = useAtomValue(themeState);
  const graphMetadata = useAtomValue(graphMetadataState);
  const project = useAtomValue(projectState);
  const resolvedTheme = resolveMonacoDisplayTheme(theme, appTheme);
  const isResizable = language != null && RESIZABLE_LANGUAGES.has(language);
  const effectiveEnableFolding = enableFolding || shouldEnableMarkdownFolding(language);
  const editorIdentityKey = name?.trim() || label;
  const modelCacheKey = buildCodeEditorModelCacheKey({
    projectId: project.metadata.id,
    graphId: graphMetadata?.id,
    nodeId: id,
    editorKey: editorIdentityKey,
    language,
    interpolationSyntax,
  });
  const editorMountKey = `${id ?? 'node-editor'}::${editorIdentityKey}::${language ?? 'language'}::${resolvedTheme ?? 'theme'}::${
    interpolationSyntax ?? 'no-interpolation'
  }::${effectiveEnableFolding ? 'folding-on' : 'folding-off'}::${modelCacheKey ?? 'uncached-model'}`;
  const errorLineHighlightKey = getErrorLineHighlightKey(errorLineHighlight);
  const activeErrorLineHighlight =
    errorLineHighlightKey &&
    dismissedErrorLineHighlightKey !== errorLineHighlightKey &&
    displayValue === errorLineHighlight?.source
      ? errorLineHighlight
      : undefined;
  const textStats = showTextStats ? getTextEditorStats(displayValue) : undefined;
  const spellcheckStatusMessage = getSpellcheckStatusMessage(spellcheckStatus);
  const [debouncedJsonTemplateValidation, setDebouncedJsonTemplateValidation] = useState({
    editorMountKey,
    value: displayValue,
  });
  const jsonTemplateValidationValue =
    debouncedJsonTemplateValidation.editorMountKey === editorMountKey
      ? debouncedJsonTemplateValidation.value
      : displayValue;
  const jsonTemplateValidityStatus = getJsonTemplateValidityStatus(interpolationSyntax, jsonTemplateValidationValue);
  const mountedEditor = mountedEditorState?.editorMountKey === editorMountKey ? mountedEditorState.editor : undefined;
  const footerCenter = (textStats || spellcheckStatusMessage || jsonTemplateValidityStatus) && (
    <div className="editor-status-line">
      {textStats && (
        <>
          <span>Words: {textStats.wordCount.toLocaleString()}</span>
          <span>Characters: {textStats.characterCount.toLocaleString()}</span>
        </>
      )}
      {spellcheckStatusMessage && <span className="editor-spellcheck-status">{spellcheckStatusMessage}</span>}
      {jsonTemplateValidityStatus && (
        <span className={`editor-json-template-status ${jsonTemplateValidityStatus.type}`}>
          {jsonTemplateValidityStatus.label}
        </span>
      )}
    </div>
  );
  const footer = (
    <CodeEditorFooter center={footerCenter} left={footerLeft} fontSize={fontSize} onAdjustFontSize={adjustFontSize} />
  );
  const handleEditorMount = (editor: monaco.editor.IStandaloneCodeEditor) => {
    setMountedEditorState({ editor, editorMountKey });
  };

  useEffect(() => {
    if (interpolationSyntax !== 'json-template') {
      return;
    }

    const timeout = window.setTimeout(() => {
      setDebouncedJsonTemplateValidation({ editorMountKey, value: displayValue });
    }, JSON_TEMPLATE_VALIDITY_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [displayValue, editorMountKey, interpolationSyntax]);

  useEffect(() => {
    if (editorInstance.current) {
      const currentValue = value;
      const textChanged = editorInstance.current.getValue() !== currentValue;
      const hasTextFocus = editorInstance.current.hasTextFocus();

      // Only set the text explicitly if we're not editing it and have a cursor position.
      if (textChanged && !hasTextFocus) {
        editorInstance.current.setValue(currentValue ?? '');
        setDisplayValue(currentValue ?? '');
      }

      editorInstance.current.updateOptions({
        readOnly: isEditorReadOnly,
      });
    } else {
      setDisplayValue(value ?? '');
    }
  }, [value, isEditorReadOnly]);

  const handleEditorChange = (newText: string) => {
    setDisplayValue(newText);
    spellcheckRunId.current += 1;
    clearCodeEditorSpellcheckMarkers(editorInstance.current);
    setSpellcheckStatus(undefined);

    if (errorLineHighlightKey && newText !== errorLineHighlight?.source) {
      setDismissedErrorLineHighlightKey(errorLineHighlightKey);
    }

    onChangeLatest.current?.(newText);
  };

  const handleKeyDown = (e: monaco.IKeyboardEvent) => {
    if (e.keyCode === 9 /* Escape */) {
      const escapeResult = handleCodeEditorEscape({
        editor: editorInstance.current,
        onClose,
      });

      if (escapeResult !== 'noop') {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  };

  const handleCheckSpelling = async () => {
    const editor = editorInstance.current;

    if (!editor) {
      return;
    }

    const runId = spellcheckRunId.current + 1;
    spellcheckRunId.current = runId;
    setSpellcheckStatus({ type: 'checking' });

    try {
      const result = await runCodeEditorSpellcheck(editor);

      if (spellcheckRunId.current === runId) {
        setSpellcheckStatus({ type: 'done', result });
      } else {
        clearCodeEditorSpellcheckMarkers(editor);
      }
    } catch {
      if (spellcheckRunId.current === runId) {
        setSpellcheckStatus({ type: 'error', message: 'Spellcheck failed to load' });
      }
    }
  };

  const handleJsonStringEdit = (range: JsonStringPreviewRange, decodedValue: string) => {
    replaceJsonStringLiteral(mountedEditor, range, decodedValue);
  };

  useEffect(
    () => () => {
      spellcheckRunId.current += 1;
      clearCodeEditorSpellcheckMarkers(editorInstance.current);
    },
    [],
  );

  useEffect(() => {
    if (!footerActionBridge || !mountedEditor) {
      return undefined;
    }

    footerActionBridge.setSelectedTextGetter(() => getSelectedEditorText(mountedEditor));

    return () => {
      footerActionBridge.setSelectedTextGetter(undefined);
    };
  }, [footerActionBridge, mountedEditor]);

  return (
    <div className="editor-wrapper-wrapper">
      {label && <Label htmlFor="">{label}</Label>}
      {helperMessage && (
        <div className="node-editor-code-helper">
          <HelperMessage>{helperMessage}</HelperMessage>
        </div>
      )}
      {isResizable ? (
        <ResizableCodeEditorViewport
          editorMountKey={editorMountKey}
          editorInstance={editorInstance}
          text={displayValue}
          onChange={handleEditorChange}
          theme={resolvedTheme}
          language={language}
          interpolationSyntax={interpolationSyntax}
          isReadonly={isEditorReadOnly}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          enableFolding={effectiveEnableFolding}
          modelCacheKey={modelCacheKey}
          onSpellcheckAction={handleCheckSpelling}
          mountedEditor={mountedEditor}
          onEditJsonString={!isEditorReadOnly ? handleJsonStringEdit : undefined}
          onEditorMount={handleEditorMount}
          editorKey={editorIdentityKey}
          nodeType={nodeType}
          defaultHeight={defaultHeight}
          errorLineHighlight={activeErrorLineHighlight}
          footer={footer}
        />
      ) : (
        <NonResizableCodeEditorViewport
          editorMountKey={editorMountKey}
          editorInstance={editorInstance}
          text={displayValue}
          onChange={handleEditorChange}
          theme={resolvedTheme}
          language={language}
          interpolationSyntax={interpolationSyntax}
          isReadonly={isEditorReadOnly}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          enableFolding={effectiveEnableFolding}
          modelCacheKey={modelCacheKey}
          onSpellcheckAction={handleCheckSpelling}
          mountedEditor={mountedEditor}
          onEditJsonString={!isEditorReadOnly ? handleJsonStringEdit : undefined}
          onEditorMount={handleEditorMount}
          editorKey={editorIdentityKey}
          defaultHeight={defaultHeight}
          errorLineHighlight={activeErrorLineHighlight}
          footer={footer}
        />
      )}
      {postEditorHelperMessage && (
        <div className="node-editor-code-helper node-editor-code-helper-after">
          <HelperMessage>{postEditorHelperMessage}</HelperMessage>
        </div>
      )}
    </div>
  );
};

type ViewportProps = {
  editorMountKey: string;
  editorInstance: MutableRefObject<monaco.editor.IStandaloneCodeEditor | undefined>;
  text: string;
  onChange: ((value: string) => void) | undefined;
  theme: string | undefined;
  language: string | undefined;
  interpolationSyntax: EditorInterpolationSyntax | undefined;
  isReadonly: boolean;
  onKeyDown: (e: monaco.IKeyboardEvent) => void;
  autoFocus: boolean | undefined;
  enableFolding: boolean | undefined;
  modelCacheKey: string | undefined;
  onSpellcheckAction: () => void | Promise<void>;
  mountedEditor: monaco.editor.IStandaloneCodeEditor | undefined;
  onEditJsonString?: (range: JsonStringPreviewRange, decodedValue: string) => void;
  onEditorMount: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  editorKey: string | undefined;
  errorLineHighlight?: CodeNodeErrorLineHighlight;
  footer: ReactNode;
};

const CodeEditorLoadingFallback: FC = () => (
  <div className="editor-container code-editor-loading-placeholder" aria-busy="true">
    Loading editor...
  </div>
);

const SuspendedCodeEditor: FC<ViewportProps> = ({
  editorMountKey,
  editorInstance,
  text,
  onChange,
  theme,
  language,
  interpolationSyntax,
  isReadonly,
  onKeyDown,
  autoFocus,
  enableFolding,
  modelCacheKey,
  onSpellcheckAction,
  onEditorMount,
  errorLineHighlight,
}) => (
  <Suspense fallback={<CodeEditorLoadingFallback />}>
    <LazyCodeEditor
      key={editorMountKey}
      editorRef={editorInstance}
      text={text}
      onChange={onChange}
      theme={theme}
      language={language}
      interpolationSyntax={interpolationSyntax}
      isReadonly={isReadonly}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      enableFolding={enableFolding}
      modelCacheKey={modelCacheKey}
      onSpellcheckAction={onSpellcheckAction}
      onEditorMount={onEditorMount}
      errorLineHighlight={errorLineHighlight}
    />
  </Suspense>
);

const ResizableCodeEditorViewport: FC<
  ViewportProps & {
    nodeType: string | undefined;
    defaultHeight: number | undefined;
  }
> = ({ nodeType, defaultHeight, ...editorProps }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const jsonPreviewEnabled = shouldEnableJsonStringPreview(editorProps.language);
  const { viewportHeight, resizeHandleProps } = useNodeEditorCodeViewportHeight({
    nodeType,
    editorKey: editorProps.editorKey,
    defaultHeight,
  });

  return (
    <div ref={rootRef} className="editor-viewport-shell" style={{ height: viewportHeight }}>
      <div className="editor-wrapper">
        <SuspendedCodeEditor {...editorProps} />
      </div>
      {editorProps.footer}
      <ResizeHandle
        className="node-editor-code-resize-handle"
        dragCursor={resizeCursorStyles.vertical}
        {...resizeHandleProps}
      />
      <JsonStringPreviewAffordance
        buttonCoordinateMode="root"
        editor={editorProps.mountedEditor}
        enabled={jsonPreviewEnabled}
        minDecodedLength={0}
        onEditString={editorProps.onEditJsonString}
        rootRef={rootRef}
        text={editorProps.text}
      />
    </div>
  );
};

const NonResizableCodeEditorViewport: FC<
  ViewportProps & {
    defaultHeight: number | undefined;
  }
> = ({ defaultHeight, ...editorProps }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const jsonPreviewEnabled = shouldEnableJsonStringPreview(editorProps.language);
  const staticViewportStyle = { height: resolveStaticViewportHeight(defaultHeight) };

  return (
    <div ref={rootRef} className="editor-viewport-shell node-editor-static-code-editor" style={staticViewportStyle}>
      <div className="editor-wrapper">
        <SuspendedCodeEditor {...editorProps} />
      </div>
      {editorProps.footer}
      <JsonStringPreviewAffordance
        buttonCoordinateMode="root"
        editor={editorProps.mountedEditor}
        enabled={jsonPreviewEnabled}
        minDecodedLength={0}
        onEditString={editorProps.onEditJsonString}
        rootRef={rootRef}
        text={editorProps.text}
      />
    </div>
  );
};
