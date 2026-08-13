import { useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { type ChartNode, type StringListEditorDefinition } from '@valerypopoff/rivet2-core';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import { Field, HelperMessage } from '@atlaskit/form';
import { css } from '@emotion/react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { getHelperMessage } from './editorUtils';
import {
  createEditableStringListRow,
  type EditableStringListRow,
  createEditableStringListRows,
  getEditableStringListValues,
  moveEditableStringListRows,
  prepareStringListPortBindingEdit,
  reconcileEditableStringListRows,
} from '../../domain/graphEditing/stringListPortBinding';
import { useEditNodeWithConnectionsCommand } from '../../commands/editNodeWithConnectionsCommand';
import { useAtomValue } from 'jotai';
import { connectionsState, graphState } from '../../state/graph';
import {
  getRecoverableNodeConnectionsForNode,
  recoverableNodeConnectionsStatePerGraph,
} from '../../state/recoverableNodeConnections';

const styles = css`
  & > div:first-of-type {
    margin-top: 0 !important;
  }

  .string-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .string-item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .string-item.dragging {
    z-index: 1;
  }

  .string-item-input {
    flex: 1;
  }

  .drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 8px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 4px;
    }
    background: transparent;
    color: var(--foreground-muted);
    cursor: grab;
    flex-shrink: 0;
    touch-action: none;

    &:hover:not(:disabled) {
      background: var(--grey-dark);
      color: var(--foreground);
    }

    &:active:not(:disabled) {
      cursor: grabbing;
    }

    &:disabled {
      cursor: default;
      opacity: 0.45;
    }
  }

  .add-item {
    margin-top: 8px;
    min-width: 96px;
    justify-content: center;
  }

  .delete-item {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;

    > span {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .helperMessage {
    margin-top: 8px;
    margin-bottom: 8px;
  }
`;

type StringListEditorProps = SharedEditorProps & {
  editor: StringListEditorDefinition<ChartNode>;
};

export const StringListEditor: FC<StringListEditorProps> = ({
  node,
  isReadonly,
  isDisabled,
  onChange,
  editor,
  onClose,
}) => {
  const data = node.data as Record<string, unknown>;
  const stringListValue = data[editor.dataKey] as string[] | string | undefined;
  const connections = useAtomValue(connectionsState);
  const graph = useAtomValue(graphState);
  const recoverableConnectionsByGraph = useAtomValue(recoverableNodeConnectionsStatePerGraph);
  const recoverableConnections = useMemo(
    () =>
      getRecoverableNodeConnectionsForNode(
        graph.metadata?.id ? recoverableConnectionsByGraph[graph.metadata.id] ?? {} : {},
        node.id,
      ),
    [graph.metadata?.id, node.id, recoverableConnectionsByGraph],
  );
  const editNodeWithConnections = useEditNodeWithConnectionsCommand();

  const stringList = useMemo(
    () => (!stringListValue ? [] : Array.isArray(stringListValue) ? stringListValue : [stringListValue]),
    [stringListValue],
  );

  const helperMessage = getHelperMessage(editor, node.data);
  const canReorder = editor.reorderable === true && !isReadonly && !isDisabled;
  const [rows, setRows] = useState<EditableStringListRow[]>(() => createEditableStringListRows(stringList));
  const [pendingAutoFocusUiId, setPendingAutoFocusUiId] = useState<string | null>(null);
  const nodeIdRef = useRef(node.id);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const commitRows = (previousRows: readonly EditableStringListRow[], nextRows: readonly EditableStringListRow[]) => {
    const nextValues = getEditableStringListValues(nextRows);

    if (editor.portBinding) {
      const { nextNode, nextConnections, nextRecoverableConnections } = prepareStringListPortBindingEdit({
        node,
        dataKey: editor.dataKey,
        portBinding: editor.portBinding,
        previousRows,
        nextRows,
        connections,
        recoverableConnections,
      });

      editNodeWithConnections({
        nodeId: node.id,
        newNode: nextNode,
        nextConnections,
        nextRecoverableConnections,
      });

      return;
    }

    onChange({
      ...node,
      data: {
        ...data,
        [editor.dataKey]: nextValues,
      },
    });
  };

  const applyRowsChange = (getNextRows: (currentRows: readonly EditableStringListRow[]) => EditableStringListRow[]) => {
    const nextRows = getNextRows(rows);
    setRows(nextRows);
    commitRows(rows, nextRows);
  };

  const handleAddItem = () => {
    const nextRow = createEditableStringListRow(editor.newItemDefault ?? '');
    setPendingAutoFocusUiId(nextRow.uiId);
    applyRowsChange((currentRows) => [...currentRows, nextRow]);
  };

  const handleDeleteItem = (uiId: string) => {
    applyRowsChange((currentRows) => currentRows.filter((row) => row.uiId !== uiId));
  };

  const handleItemChange = (uiId: string, value: string) => {
    applyRowsChange((currentRows) => currentRows.map((row) => (row.uiId === uiId ? { ...row, value } : row)));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!canReorder || !over || active.id === over.id) {
      return;
    }

    applyRowsChange((currentRows) => moveEditableStringListRows(currentRows, String(active.id), String(over.id)));
  };

  useEffect(() => {
    if (nodeIdRef.current !== node.id) {
      nodeIdRef.current = node.id;
      setPendingAutoFocusUiId(null);
      setRows(createEditableStringListRows(stringList));
      return;
    }

    setRows((previousRows) => reconcileEditableStringListRows(previousRows, stringList));
  }, [node.id, stringList]);

  useEffect(() => {
    if (!pendingAutoFocusUiId) {
      return;
    }

    if (rows.some((row) => row.uiId === pendingAutoFocusUiId)) {
      setPendingAutoFocusUiId(null);
    }
  }, [pendingAutoFocusUiId, rows]);

  return (
    <StringList
      label={editor.label}
      dataKey={editor.dataKey}
      placeholder={editor.placeholder}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      canReorder={canReorder}
      helperMessage={helperMessage}
      rows={rows}
      pendingAutoFocusUiId={pendingAutoFocusUiId}
      onAddItem={handleAddItem}
      onDeleteItem={handleDeleteItem}
      onItemChange={handleItemChange}
      onDragEnd={handleDragEnd}
      onClose={onClose}
      sensors={sensors}
    />
  );
};

type StringListProps = {
  label: string;
  dataKey: string;
  placeholder?: string;
  isReadonly?: boolean;
  isDisabled?: boolean;
  canReorder: boolean;
  rows: EditableStringListRow[];
  pendingAutoFocusUiId: string | null;
  helperMessage?: string;
  onAddItem: () => void;
  onDeleteItem: (uiId: string) => void;
  onItemChange: (uiId: string, value: string) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onClose?: () => void;
  sensors: ReturnType<typeof useSensors>;
};

const StringList: FC<StringListProps> = ({
  label,
  dataKey,
  placeholder,
  isReadonly,
  isDisabled,
  canReorder,
  rows,
  pendingAutoFocusUiId,
  helperMessage,
  onAddItem,
  onDeleteItem,
  onItemChange,
  onDragEnd,
  onClose,
  sensors,
}) => {
  const showReorderHandle = canReorder && rows.length > 1;

  return (
    <div css={styles}>
      <Field name={dataKey} label={label} isDisabled={isDisabled}>
        {({ fieldProps }) => (
          <>
            {helperMessage && (
              <div className="helperMessage">
                <HelperMessage>{helperMessage}</HelperMessage>
              </div>
            )}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={rows.map((row) => row.uiId)} strategy={verticalListSortingStrategy}>
                <div className="string-list">
                  {rows.map((row) => (
                    <SortableStringListItem
                      key={row.uiId}
                      row={row}
                      fieldProps={fieldProps}
                      placeholder={placeholder}
                      shouldAutoFocus={row.uiId === pendingAutoFocusUiId}
                      showReorderHandle={showReorderHandle}
                      isDisabled={isDisabled}
                      isReadonly={isReadonly}
                      onDeleteItem={onDeleteItem}
                      onItemChange={onItemChange}
                      onClose={onClose}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            <Button className="add-item" appearance="primary" onClick={onAddItem} isDisabled={isDisabled || isReadonly}>
              Add
            </Button>
          </>
        )}
      </Field>
    </div>
  );
};

const SortableStringListItem: FC<{
  row: EditableStringListRow;
  fieldProps: any;
  placeholder?: string;
  shouldAutoFocus: boolean;
  showReorderHandle: boolean;
  isDisabled?: boolean;
  isReadonly?: boolean;
  onDeleteItem: (uiId: string) => void;
  onItemChange: (uiId: string, value: string) => void;
  onClose?: () => void;
}> = ({
  row,
  fieldProps,
  placeholder,
  shouldAutoFocus,
  showReorderHandle,
  isDisabled,
  isReadonly,
  onDeleteItem,
  onItemChange,
  onClose,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.uiId,
    disabled: !showReorderHandle,
  });

  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={`string-item${isDragging ? ' dragging' : ''}`}>
      {showReorderHandle ? (
        <button type="button" className="drag-handle" aria-label="Reorder item" {...attributes} {...listeners}>
          <DragHandleIcon />
        </button>
      ) : null}
      <div className="string-item-input">
        <TextField
          {...fieldProps}
          value={row.value}
          autoFocus={shouldAutoFocus}
          onChange={(e) => onItemChange(row.uiId, (e.target as HTMLInputElement).value)}
          isDisabled={isDisabled}
          isReadOnly={isReadonly}
          placeholder={placeholder ?? 'Item'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose?.();
            }
          }}
        />
      </div>
      <Button
        className="delete-item"
        appearance="subtle"
        onClick={() => onDeleteItem(row.uiId)}
        isDisabled={isDisabled || isReadonly}
      >
        <CrossIcon />
      </Button>
    </div>
  );
};

const DragHandleIcon: FC = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="4" cy="3" r="1" fill="currentColor" />
    <circle cx="10" cy="3" r="1" fill="currentColor" />
    <circle cx="4" cy="7" r="1" fill="currentColor" />
    <circle cx="10" cy="7" r="1" fill="currentColor" />
    <circle cx="4" cy="11" r="1" fill="currentColor" />
    <circle cx="10" cy="11" r="1" fill="currentColor" />
  </svg>
);
