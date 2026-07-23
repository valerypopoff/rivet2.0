import { type EditorDefinition, type ChartNode } from '@valerypopoff/rivet2-core';
import clsx from 'clsx';
import { type FC, type ReactNode } from 'react';
import { match } from 'ts-pattern';
import PlugIcon from '../../assets/icons/plug-icon.svg?react';
import { type SharedEditorProps } from './SharedEditorProps';
import { DefaultAnyDataEditor } from './AnyEditor';
import { DefaultCodeEditor } from './CodeEditor';
import { DefaultColorEditor } from './ColorEditor';
import { DefaultDataTypeSelector } from './DataTypeEditor';
import { DefaultDatasetSelectorEditor } from './DatasetSelectorEditor';
import { DefaultDropdownEditor } from './DropdownEditor';
import { DefaultFileBrowserEditor, DefaultFilePathBrowserEditor } from './FileBrowserEditor';
import { DefaultGraphSelectorEditor } from './GraphSelectorEditor';
import { DefaultImageBrowserEditor } from './ImageBrowserEditor';
import { DefaultNumberEditor } from './NumberEditor';
import { DefaultSegmentedEditor } from './SegmentedEditor';
import { DefaultStringEditor } from './StringEditor';
import { DefaultToggleEditor } from './ToggleEditor';
// eslint-disable-next-line import/no-cycle
import { EditorGroup } from './EditorGroup';
import { KeyValuePairEditor } from './KeyValuePairEditor';
import { StringListEditor } from './StringListEditor';
import { CustomEditor } from './CustomEditor';
import { DefaultDynamicEditor } from './DynamicEditor';
import { Tooltip } from '../Tooltip';
import { DefaultDirectoryBrowserEditor } from './DirectoryBrowserEditor';
import { InfoEditor } from './InfoEditor';
import { JsonObjectEditor } from './JsonObjectEditor';

export const DefaultNodeEditorField: FC<
  SharedEditorProps & {
    editor: EditorDefinition<ChartNode>;
    editorKey: string;
    codeEditorFooterLeft?: ReactNode;
  }
> = ({ node, onChange, editor, editorKey, isReadonly, isDisabled, onClose, onRefreshEditors, codeEditorFooterLeft }) => {
  const data = node.data as Record<string, unknown>;

  if (editor.hideIf?.(node.data)) {
    return null;
  }

  const sharedProps: SharedEditorProps = {
    node,
    onChange,
    isReadonly,
    onClose,
    onRefreshEditors,
    isDisabled,
  };

  const input = match(editor)
    .with({ type: 'info' }, (editor) => <InfoEditor node={node} editor={editor} />)
    .with({ type: 'string' }, (editor) => <DefaultStringEditor {...sharedProps} editor={editor} />)
    .with({ type: 'toggle' }, (editor) => <DefaultToggleEditor {...sharedProps} editor={editor} />)
    .with({ type: 'dataTypeSelector' }, (editor) => <DefaultDataTypeSelector {...sharedProps} editor={editor} />)
    .with({ type: 'anyData' }, (editor) => <DefaultAnyDataEditor {...sharedProps} editor={editor} />)
    .with({ type: 'jsonObject' }, (editor) => <JsonObjectEditor {...sharedProps} editor={editor} />)
    .with({ type: 'dropdown' }, (editor) => <DefaultDropdownEditor {...sharedProps} editor={editor} />)
    .with({ type: 'segmented' }, (editor) => <DefaultSegmentedEditor {...sharedProps} editor={editor} />)
    .with({ type: 'number' }, (editor) => <DefaultNumberEditor {...sharedProps} editor={editor} />)
    .with({ type: 'code' }, (editor) => (
      <DefaultCodeEditor {...sharedProps} editor={editor} footerLeft={codeEditorFooterLeft} />
    ))
    .with({ type: 'graphSelector' }, (editor) => <DefaultGraphSelectorEditor {...sharedProps} editor={editor} />)
    .with({ type: 'datasetSelector' }, (editor) => <DefaultDatasetSelectorEditor {...sharedProps} editor={editor} />)
    .with({ type: 'color' }, (editor) => <DefaultColorEditor {...sharedProps} editor={editor} />)
    .with({ type: 'fileBrowser' }, (editor) => <DefaultFileBrowserEditor {...sharedProps} editor={editor} />)
    .with({ type: 'imageBrowser' }, (editor) => <DefaultImageBrowserEditor {...sharedProps} editor={editor} />)
    .with({ type: 'group' }, (editor) => <EditorGroup {...sharedProps} editor={editor} editorKey={editorKey} />)
    .with({ type: 'keyValuePair' }, (editor) => <KeyValuePairEditor {...sharedProps} editor={editor} />)
    .with({ type: 'stringList' }, (editor) => <StringListEditor {...sharedProps} editor={editor} />)
    .with({ type: 'custom' }, (editor) => <CustomEditor {...sharedProps} editor={editor} />)
    .with({ type: 'dynamic' }, (editor) => <DefaultDynamicEditor {...sharedProps} editor={editor} />)
    .with({ type: 'filePathBrowser' }, (editor) => <DefaultFilePathBrowserEditor {...sharedProps} editor={editor} />)
    .with({ type: 'directoryBrowser' }, (editor) => <DefaultDirectoryBrowserEditor {...sharedProps} editor={editor} />)
    .exhaustive();

  const sideControlDataKey = editor.type !== 'group' ? editor.useInputToggleDataKey : undefined;
  const hasSideControl = Boolean(sideControlDataKey);
  const isUsingInputPort = sideControlDataKey ? Boolean(data[sideControlDataKey]) : false;
  const useInputLabelSuffix = editor.label.trim();
  const useInputTooltip = useInputLabelSuffix ? `Use an input port for ${useInputLabelSuffix}` : 'Use an input port';

  const toggle = hasSideControl ? (
    <div className="use-input-toggle">
      <Tooltip content={useInputTooltip}>
        <button
          type="button"
          className={clsx('use-input-toggle-button', isUsingInputPort && 'is-active')}
          aria-label={useInputTooltip}
          aria-pressed={isUsingInputPort}
          disabled={isReadonly || sharedProps.isDisabled}
          onClick={() =>
            onChange({
              ...node,
              data: {
                ...data,
                [sideControlDataKey!]: !isUsingInputPort,
              },
            })
          }
        >
          <PlugIcon />
        </button>
      </Tooltip>
    </div>
  ) : null;

  return (
    <div className={clsx('row', editor.type, hasSideControl && 'has-side-control')}>
      {input}
      {toggle}
    </div>
  );
};
