import { useState, type CSSProperties, type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { type ChartNode, type KeyValuePairEditorDefinition } from '@valerypopoff/rivet2-core';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import { Field, HelperMessage } from '@atlaskit/form';
import { css } from '@emotion/react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import EyeIcon from 'majesticons/line/eye-line.svg?react';
import EyeOffIcon from 'majesticons/line/eye-off-line.svg?react';
import { getHelperMessage } from './editorUtils';
import { produce } from 'immer';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { getInterpolationTextSegments } from './interpolationTextSegments';

type KVPair = {
  key: string;
  value: string;
};

const styles = css`
  & > div:first-of-type {
    margin-top: 0 !important;
  }

  .key-value-pairs-container {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .key-value-pairs {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .key-value-pair {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .key-value-pair.dragging {
    z-index: 1;
  }

  .key-value-key-field,
  .interpolation-value-field,
  .key-value-value-field {
    flex: 1 1 0;
    min-width: 0;
  }

  .drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--foreground-muted);
    cursor: grab;
    flex-shrink: 0;
    touch-action: none;
  }

  .interpolation-value-field {
    position: relative;
  }

  .interpolation-value-display {
    position: absolute;
    z-index: 1;
    inset: 0;
    display: flex;
    align-items: center;
    padding: 0 8px;
    pointer-events: none;
    white-space: pre;
    overflow: hidden;
    color: var(--foreground);
    font: inherit;
    line-height: inherit;
  }

  .interpolation-value-display-content {
    flex: none;
  }

  .interpolation-value-token {
    color: var(--highlighted-text);
  }

  .interpolation-value-field input {
    color: transparent !important;
    caret-color: var(--foreground);

    &::selection {
      color: transparent;
      background-color: Highlight;
    }

    &::placeholder {
      color: var(--foreground-muted);
    }
  }

  .add-pair {
    min-width: 96px;
    justify-content: center;
  }

  .delete-pair {
    display: flex;
    align-items: center;
    justify-content: center;

    > span {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .buttons {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
`;

type KeyValuePairEditorProps = SharedEditorProps & {
  editor: KeyValuePairEditorDefinition<ChartNode>;
};

export const KeyValuePairEditor: FC<KeyValuePairEditorProps> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);
  const pairs = (data[editor.dataKey] as KVPair[] | undefined) ?? [];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const commitPairs = (nextPairs: KVPair[]) => {
    onChange({
      ...node,
      data: {
        ...data,
        [editor.dataKey]: nextPairs,
      },
    });
  };

  const handleAddPair = () => commitPairs([...pairs, { key: '', value: '' }]);

  const handleDeletePair = (index: number) => {
    commitPairs(
      produce(pairs, (draft) => {
        draft.splice(index, 1);
      }),
    );
  };

  const handlePairChange = (index: number, keyOrValue: 'key' | 'value', value: string) => {
    commitPairs(
      produce(pairs, (draft) => {
        draft[index]![keyOrValue] = value;
      }),
    );
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!editor.reorderable || !over || active.id === over.id) return;
    const from = Number(active.id);
    const to = Number(over.id);
    commitPairs(arrayMove(pairs, from, to));
  };

  return (
    <KeyValuePairs
      label={editor.label}
      name={editor.dataKey}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      keyValuePairs={pairs}
      onAddPair={handleAddPair}
      onDeletePair={handleDeletePair}
      onPairChange={handlePairChange}
      isValuesSecret={editor.valuesSecret ?? false}
      keyPlaceholder={editor.keyPlaceholder}
      valuePlaceholder={editor.valuePlaceholder}
      itemLabel={editor.itemLabel}
      reorderable={editor.reorderable === true}
      highlightInterpolationTokens={editor.highlightInterpolationTokens === true}
      sensors={sensors}
      onDragEnd={handleDragEnd}
      helperMessage={helperMessage}
    />
  );
};

type KeyValuePairsProps = {
  label: string;
  name: string;
  isReadonly?: boolean;
  isDisabled?: boolean;
  keyValuePairs: KVPair[];
  helperMessage?: string;
  isValuesSecret?: boolean;
  onAddPair: () => void;
  onDeletePair: (index: number) => void;
  onPairChange: (index: number, keyOrValue: 'key' | 'value', value: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  itemLabel?: string;
  reorderable: boolean;
  highlightInterpolationTokens: boolean;
  sensors: ReturnType<typeof useSensors>;
  onDragEnd: (event: DragEndEvent) => void;
};

export const KeyValuePairs: FC<KeyValuePairsProps> = ({
  label,
  name,
  isReadonly,
  isDisabled,
  isValuesSecret,
  keyValuePairs,
  helperMessage,
  onAddPair,
  onDeletePair,
  onPairChange,
  keyPlaceholder,
  valuePlaceholder,
  itemLabel,
  reorderable,
  highlightInterpolationTokens,
  sensors,
  onDragEnd,
}) => {
  const [showingValues, setShowingValues] = useState(false);

  return (
    <div css={styles}>
      <Field name={name} label={label} isDisabled={isDisabled}>
        {({ fieldProps }) => (
          <div className="key-value-pairs-container">
            {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
            {keyValuePairs.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={keyValuePairs.map((_, index) => String(index))} strategy={verticalListSortingStrategy}>
                  <div className="key-value-pairs">
                    {keyValuePairs.map((pair, index) => (
                      <SortablePair key={index} pair={pair} index={index} fieldProps={fieldProps}
                        isDisabled={isDisabled} isReadonly={isReadonly} isValuesSecret={isValuesSecret}
                        showingValues={showingValues} keyPlaceholder={keyPlaceholder} valuePlaceholder={valuePlaceholder}
                        itemLabel={itemLabel}
                        reorderable={reorderable && keyValuePairs.length > 1} highlightInterpolationTokens={highlightInterpolationTokens}
                        onPairChange={onPairChange} onDeletePair={onDeletePair} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
            <div className="buttons">
              <Button
                className="add-pair"
                appearance="primary"
                onClick={onAddPair}
                isDisabled={isDisabled || isReadonly}
              >
                {itemLabel ? `Add ${itemLabel}` : 'Add'}
              </Button>
              {isValuesSecret && (
                <Button
                  className="show-values"
                  appearance="subtle"
                  onClick={() => setShowingValues(!showingValues)}
                  isDisabled={isDisabled || isReadonly}
                  iconBefore={
                    showingValues ? <EyeIcon width={16} height={16} /> : <EyeOffIcon width={16} height={16} />
                  }
                >
                  {showingValues ? 'Hide Values' : 'Show Values'}
                </Button>
              )}
            </div>
          </div>
        )}
      </Field>
    </div>
  );
};

const SortablePair: FC<{
  pair: KVPair; index: number; fieldProps: any; isDisabled?: boolean; isReadonly?: boolean; isValuesSecret?: boolean;
  showingValues: boolean; keyPlaceholder?: string; valuePlaceholder?: string; itemLabel?: string; reorderable: boolean; highlightInterpolationTokens: boolean;
  onPairChange: (index: number, keyOrValue: 'key' | 'value', value: string) => void; onDeletePair: (index: number) => void;
}> = ({ pair, index, fieldProps, isDisabled, isReadonly, isValuesSecret, showingValues, keyPlaceholder, valuePlaceholder, itemLabel, reorderable, highlightInterpolationTokens, onPairChange, onDeletePair }) => {
  const [scrollLeft, setScrollLeft] = useState(0);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(index), disabled: !reorderable });
  const style: CSSProperties = { transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition };
  const valueInput = <TextField {...fieldProps} type={isValuesSecret ? (showingValues ? 'text' : 'password') : 'text'} value={pair.value}
    onChange={(e) => onPairChange(index, 'value', (e.target as HTMLInputElement).value)} isDisabled={isDisabled} isReadOnly={isReadonly}
    placeholder={valuePlaceholder ?? 'Value'} onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)} />;
  return <div ref={setNodeRef} style={style} className={`key-value-pair${isDragging ? ' dragging' : ''}`}>
    {reorderable ? <button type="button" className="drag-handle" aria-label={itemLabel ? `Reorder ${itemLabel}` : 'Reorder option'} {...attributes} {...listeners}>⋮⋮</button> : null}
    <div className="key-value-key-field"><TextField {...fieldProps} value={pair.key} onChange={(e) => onPairChange(index, 'key', (e.target as HTMLInputElement).value)}
      isDisabled={isDisabled} isReadOnly={isReadonly} placeholder={keyPlaceholder ?? 'Key'} /></div>
    {highlightInterpolationTokens && !isValuesSecret ? <div className="interpolation-value-field">
      <div className="interpolation-value-display" aria-hidden="true"><span className="interpolation-value-display-content" style={{ transform: `translateX(-${scrollLeft}px)` }}>
        {getInterpolationTextSegments(pair.value).map((segment, segmentIndex) =>
          <span className={segment.isInterpolation ? 'interpolation-value-token' : undefined} key={segmentIndex}>{segment.text}</span>)}
      </span></div>{valueInput}</div> : <div className="key-value-value-field">{valueInput}</div>}
    <Button className="delete-pair" appearance="subtle" aria-label={itemLabel ? `Delete ${itemLabel}` : undefined} onClick={() => onDeletePair(index)} isDisabled={isDisabled || isReadonly} style={{ marginRight: '8px' }}><CrossIcon /></Button>
  </div>;
};
