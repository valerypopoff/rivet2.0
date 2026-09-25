import { type FC } from 'react';
import { type ImageNode } from '@valerypopoff/rivet2-core';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes';
import { LLMNodeBody } from './LLMNodeBody.js';

function getImageSourceValue(node: ImageNode): string {
  if (node.data.sourceType === 'base64') {
    if (node.data.useBase64Input) return 'From input';
    return node.data.base64?.trim() ? 'Entered' : 'Empty';
  }

  if (node.data.useDataInput) return 'From input';
  return node.data.data ? 'File selected' : 'No image selected';
}

export const ImageNodeBody: FC<{ node: ImageNode }> = ({ node }) => {
  const isBase64 = node.data.sourceType === 'base64';
  const mediaType = node.data.useMediaTypeInput
    ? 'From input'
    : (node.data.mediaType ?? 'image/png').replace('image/', '').toUpperCase();

  return (
    <LLMNodeBody
      sections={[{
        id: 'settings',
        fields: [
          { label: 'Image source', value: isBase64 ? 'Base64' : 'Binary data' },
          { label: isBase64 ? 'Base64' : 'Image', value: getImageSourceValue(node) },
          { label: 'Media Type', value: mediaType },
        ],
      }]}
    />
  );
};

export const imageNodeDescriptor: NodeComponentDescriptor<'image'> = {
  Body: ImageNodeBody,
};
