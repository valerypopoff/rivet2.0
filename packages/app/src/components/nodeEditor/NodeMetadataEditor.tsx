import { type FC, useRef, useState } from 'react';
import InlineEdit from '@atlaskit/inline-edit';
import Textarea from '@atlaskit/textarea';
import TextField from '@atlaskit/textfield';
import { type ChartNode } from '@valerypopoff/rivet2-core';
import { NodeColorPicker } from '../NodeColorPicker.js';
import type { NodeColor } from '../../utils/nodeColor.js';

const NodeTitleInlineEditor: FC<{
  nodeId: string;
  title: string | undefined;
  onTitleChange: (title: string) => void;
}> = ({ nodeId, title, onTitleChange }) => {
  const [isEditing, setIsEditing] = useState(false);
  const titleBeforeEditRef = useRef(title ?? '');

  const startEditing = () => {
    titleBeforeEditRef.current = title ?? '';
    setIsEditing(true);
  };

  const cancelEditing = () => {
    if ((title ?? '') !== titleBeforeEditRef.current) {
      onTitleChange(titleBeforeEditRef.current);
    }

    setIsEditing(false);
  };

  const finishEditing = () => {
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <TextField
        autoFocus
        id={`node-title-${nodeId}`}
        name={`node-title-${nodeId}`}
        value={title ?? ''}
        onBlur={finishEditing}
        onChange={(event) => {
          const nextTitle = event.currentTarget.value;
          onTitleChange(nextTitle);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEditing();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            finishEditing();
          }
        }}
        placeholder="Some title"
      />
    );
  }

  return (
    <button type="button" className="node-title-read-button" aria-label="Edit node title" onClick={startEditing}>
      <div className={title ? 'title-read-content' : 'title-read-content is-empty'}>{title || 'Some title'}</div>
    </button>
  );
};

export const NodeMetadataEditor: FC<{
  node: ChartNode;
  onTitleChange: (title: string) => void;
  onDescriptionChange: (description: string | undefined) => void;
  onColorChange: (color: NodeColor | undefined) => void;
}> = ({ node, onTitleChange, onDescriptionChange, onColorChange }) => {
  const latestNodeDescriptionRef = useRef(node.description);
  const nodeDescriptionBeforeEditRef = useRef(node.description);
  latestNodeDescriptionRef.current = node.description;
  const commitDescription = (description: string | undefined) => {
    latestNodeDescriptionRef.current = description;
    onDescriptionChange(description);
  };

  return (
    <div className="node-metadata-row">
      <div className="node-color-picker">
        <NodeColorPicker currentColor={node.visualData.color} onChange={onColorChange} />
      </div>
      <div className="node-metadata-fields">
        <div className="node-title-field">
          <NodeTitleInlineEditor key={node.id} nodeId={node.id} title={node.title} onTitleChange={onTitleChange} />
        </div>
        <div className="node-description-field">
          <InlineEdit
            key={`node-description-${node.id}`}
            label="Node description"
            defaultValue={node.description ?? ''}
            onEdit={() => {
              nodeDescriptionBeforeEditRef.current = latestNodeDescriptionRef.current;
            }}
            onCancel={() => {
              if (latestNodeDescriptionRef.current !== nodeDescriptionBeforeEditRef.current) {
                commitDescription(nodeDescriptionBeforeEditRef.current);
              }
            }}
            // Keystrokes already commit; confirmation must not replay an
            // internal form buffer over a newer authoritative update.
            onConfirm={() => {}}
            hideActionButtons
            readViewFitContainerWidth
            readView={() => (
              <div className={node.description ? 'description-read-content' : 'description-read-content is-empty'}>
                {node.description || 'Description...'}
              </div>
            )}
            editView={(fieldProps, ref) => (
              <Textarea
                ref={ref}
                id={fieldProps.id}
                name={fieldProps.name}
                value={node.description ?? ''}
                isRequired={fieldProps.isRequired}
                isDisabled={fieldProps.isDisabled}
                isInvalid={fieldProps.isInvalid}
                onBlur={fieldProps.onBlur}
                onFocus={fieldProps.onFocus}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                onChange={(event) => {
                  const nextDescription = event.currentTarget.value;
                  fieldProps.onChange(nextDescription);
                  commitDescription(nextDescription);
                }}
                placeholder="Description..."
                minimumRows={3}
                resize="smart"
              />
            )}
          />
        </div>
      </div>
    </div>
  );
};
