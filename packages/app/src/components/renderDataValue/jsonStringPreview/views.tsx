import Button from '@atlaskit/button';
import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import EditIcon from 'majesticons/line/edit-pen-2-line.svg?react';
import type { FC, KeyboardEvent, MutableRefObject, PointerEvent } from 'react';
import { copyToClipboard } from '../../../utils/copyToClipboard.js';
import type { JsonStringPreviewRange } from '../jsonStringPreviewRanges.js';
import type { JsonStringPreviewButtonCoordinateMode, JsonStringPreviewButtonPlacement } from './monacoAdapter.js';

export const JsonStringPreviewButton: FC<{
  coordinateMode: JsonStringPreviewButtonCoordinateMode;
  onClosePopover(): void;
  onHide(): void;
  onKeepPreviewChange(keep: boolean): void;
  onOpen(): void;
  placement: JsonStringPreviewButtonPlacement;
  popoverOpen: boolean;
  refObject: MutableRefObject<HTMLButtonElement | null>;
}> = ({ coordinateMode, onClosePopover, onHide, onKeepPreviewChange, onOpen, placement, popoverOpen, refObject }) => {
  const releasePreview = () => {
    onKeepPreviewChange(false);
    onHide();
  };
  const activate = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  };

  return (
    <button
      type="button"
      ref={refObject}
      className={`json-string-preview-button ${coordinateMode === 'root' ? 'json-string-preview-button-local' : ''}`}
      title="Preview unescaped string"
      aria-label="Preview unescaped string"
      style={{ left: placement.left, top: placement.top }}
      onPointerDownCapture={activate}
      onPointerDown={activate}
      onMouseDownCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={activate}
      onMouseEnter={() => onKeepPreviewChange(true)}
      onPointerEnter={() => onKeepPreviewChange(true)}
      onMouseLeave={releasePreview}
      onFocus={() => onKeepPreviewChange(true)}
      onBlur={releasePreview}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && popoverOpen) {
          event.preventDefault();
          event.stopPropagation();
          onClosePopover();
        } else if (event.key === 'Enter' || event.key === ' ') {
          activate(event);
        }
      }}
    >
      Aa
    </button>
  );
};

export const JsonStringPreviewPopover: FC<{
  decodedTextRef: MutableRefObject<HTMLPreElement | null>;
  maxHeight: number;
  onEdit?(): void;
  onResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onResizePointerDown(event: PointerEvent<HTMLButtonElement>): void;
  position: { left: number; top: number };
  range: JsonStringPreviewRange;
  refObject: MutableRefObject<HTMLDivElement | null>;
  width: number;
}> = ({
  decodedTextRef,
  maxHeight,
  onEdit,
  onResizeKeyDown,
  onResizePointerDown,
  position,
  range,
  refObject,
  width,
}) => (
  <div
    ref={refObject}
    className="json-string-preview-popover"
    role="dialog"
    aria-modal="false"
    aria-label="Unescaped JSON string preview"
    style={{ left: position.left, top: position.top, width }}
    onMouseDown={(event) => event.stopPropagation()}
  >
    <div className="json-string-preview-popover-header">
      <span>Unescaped string</span>
      {onEdit && (
        <button type="button" className="json-string-preview-action-button" onClick={onEdit}>
          <EditIcon />
          Edit
        </button>
      )}
      <button
        type="button"
        className="json-string-preview-action-button"
        onClick={() => void copyToClipboard(range.decodedValue)}
      >
        <CopyIcon />
        Copy
      </button>
    </div>
    <pre ref={decodedTextRef} style={{ maxHeight }}>
      {range.decodedValue}
    </pre>
    <button
      type="button"
      className="json-string-preview-resize-handle"
      aria-label="Resize preview"
      title="Resize preview"
      onPointerDown={onResizePointerDown}
      onKeyDown={onResizeKeyDown}
    />
  </div>
);

export const EditJsonStringModal: FC<{
  draft: string;
  onCancel(): void;
  onChange(draft: string): void;
  onPointerDownCapture(event: PointerEvent<HTMLDivElement>): void;
  onSave(): void;
  refObject: MutableRefObject<HTMLDivElement | null>;
  size: { height: number; width: number };
  textAreaRef: MutableRefObject<HTMLTextAreaElement | null>;
}> = ({ draft, onCancel, onChange, onPointerDownCapture, onSave, refObject, size, textAreaRef }) => (
  <div
    className="json-string-edit-modal-backdrop"
    role="presentation"
    onPointerDown={(event) => {
      if (event.target === event.currentTarget) {
        onCancel();
      }
    }}
  >
    <div
      ref={refObject}
      className="json-string-edit-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Edit unescaped JSON string"
      data-rivet-consume-run-hotkey="true"
      style={size}
      onPointerDownCapture={onPointerDownCapture}
    >
      <div className="json-string-edit-modal-header">
        <h2>Edit unescaped string</h2>
      </div>
      <textarea
        ref={textAreaRef}
        aria-label="Unescaped string value"
        value={draft}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="json-string-edit-modal-actions">
        <button type="button" className="json-string-edit-secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <Button appearance="primary" className="json-string-edit-primary-button" onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  </div>
);
