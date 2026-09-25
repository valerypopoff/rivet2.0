import Button from '@atlaskit/button';
import { Field, HelperMessage } from '@atlaskit/form';
import {
  type ImageBrowserEditorDefinition,
  type ChartNode,
  type DataId,
  uint8ArrayToBase64,
  type DataRef,
} from '@valerypopoff/rivet2-core';
import { nanoid } from 'nanoid/non-secure';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';
import mime from 'mime';
import { wrapAsync } from '../../utils/errorHandling';
import { useIOProvider } from '../../providers/ProvidersContext';

export const DefaultImageBrowserEditor: FC<
  SharedEditorProps & {
    editor: ImageBrowserEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const ioProvider = useIOProvider();
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);

  const handleFileSelected = wrapAsync(
    async (binaryData: Uint8Array) => {
      const dataId = nanoid() as DataId;
      onChange(
        {
          ...node,
          data: {
            ...data,
            [editor.dataKey]: {
              refId: dataId,
            } satisfies DataRef,
            [editor.mediaTypeDataKey]: mime.getType(editor.dataKey) ?? 'image/png',
          },
        },
        {
          [dataId]: (await uint8ArrayToBase64(binaryData)) ?? '',
        },
      );
    },
    'Load image file',
  );

  const pickFile = wrapAsync(
    async () => {
      await ioProvider.readFileAsBinary(handleFileSelected);
    },
    'Open image picker',
  );

  const dataRef = data[editor.dataKey] as DataRef | undefined;

  return (
    <Field name={editor.dataKey} label={editor.label}>
      {() => (
        <div>
          {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
          <Button onClick={pickFile} isDisabled={isReadonly || isDisabled}>
            Pick Image
          </Button>

          {dataRef && <div className="current">Image selected</div>}
        </div>
      )}
    </Field>
  );
};
