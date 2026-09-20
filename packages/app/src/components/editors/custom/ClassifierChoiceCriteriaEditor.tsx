import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import {
  type ChartNode,
  type ClassifierChoiceCriterionData,
  type ClassifierQuestionNodeData,
  type CustomEditorDefinition,
} from '@valerypopoff/rivet2-core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { css } from '@emotion/react';
import { isEqual } from 'lodash-es';
import { type CSSProperties, type FC } from 'react';
import { CodeEditor } from '../CodeEditor';
import { type SharedEditorProps } from '../SharedEditorProps';

const styles = css`
  min-width: 0;

  .choice-criteria-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .choice-criterion {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) 32px;
    gap: 8px;
    align-items: start;
    padding: 12px;
    border: 1px solid var(--settings-collapsible-border);
    border-radius: 8px;
    background: var(--settings-collapsible-header-bg);
  }

  .choice-criterion.dragging {
    z-index: 2;
  }

  .choice-criterion-fields,
  .choice-criterion-lines {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .choice-criterion-line {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .choice-criterion-line > div:first-of-type {
    flex: 1;
  }

  .choice-criterion-drag {
    width: 28px;
    height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--foreground-muted);
    cursor: grab;
    touch-action: none;
  }

  .choice-criterion-delete,
  .choice-criterion-line-delete {
    min-width: 32px;
    padding: 0;
  }

  .choice-criteria-add {
    align-self: flex-start;
    min-width: 120px;
    justify-content: center;
  }
`;

function createCriterion(): ClassifierChoiceCriterionData {
  return {
    id: globalThis.crypto.randomUUID(),
    key: '',
    text: '',
    lines: [''],
    objectTemplate: '{}',
  };
}

function resolveCriteria(data: ClassifierQuestionNodeData): ClassifierChoiceCriterionData[] {
  if (data.choiceCriteria) {
    return data.choiceCriteria.map((criterion, index) => ({ ...criterion, id: criterion.id ?? `legacy-${index}` }));
  }
  return (data.options ?? [{ key: '', value: '' }, { key: '', value: '' }]).map((option, index) => ({
    ...createCriterion(),
    id: `legacy-${index}`,
    key: option.key,
    text: option.value,
    lines: [option.value],
  }));
}

type Props = SharedEditorProps & { editor: CustomEditorDefinition<ChartNode> };

/**
 * Choice uses a name plus a typed value. Text values deliberately keep the
 * compact shared KeyValuePair editor; this editor owns the structured list
 * and object variants where every named criterion needs its own value editor.
 */
export const ClassifierChoiceCriteriaEditor: FC<Props> = (props) => {
  const { node, onChange, isDisabled, isReadonly, onClose } = props;
  const data = node.data as ClassifierQuestionNodeData;
  const criteria = resolveCriteria(data);
  const criteriaType = data.criteriaType === 'object' ? 'object' : 'lines';
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const commit = (next: ClassifierChoiceCriterionData[]) => {
    if (isEqual(criteria, next)) return;
    onChange({ ...node, data: { ...data, choiceCriteria: next } });
  };
  const update = (index: number, next: ClassifierChoiceCriterionData) => {
    const current = criteria[index];
    if (!current || isEqual(current, next)) return;
    commit(criteria.map((criterion, criterionIndex) => (criterionIndex === index ? next : criterion)));
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = criteria.findIndex((criterion) => criterion.id === active.id);
    const to = criteria.findIndex((criterion) => criterion.id === over.id);
    if (from < 0 || to < 0) return;
    commit(arrayMove(criteria, from, to));
  };

  return (
    <div css={styles}>
      <div className="choice-criteria-content">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={criteria.map((criterion) => criterion.id!)} strategy={verticalListSortingStrategy}>
            {criteria.map((criterion, index) => (
              <ChoiceCriterionEditor
                key={criterion.id}
                criterion={criterion}
                index={index}
                criteriaType={criteriaType}
                node={node}
                isDisabled={isDisabled}
                isReadonly={isReadonly}
                onClose={onClose}
                onChange={(next) => update(index, next)}
                onDelete={() => commit(criteria.filter((_, criterionIndex) => criterionIndex !== index))}
              />
            ))}
          </SortableContext>
        </DndContext>
        <Button
          className="choice-criteria-add"
          appearance="primary"
          onClick={() => commit([...criteria, createCriterion()])}
          isDisabled={isDisabled || isReadonly}
        >
          Add criterion
        </Button>
      </div>
    </div>
  );
};

const ChoiceCriterionEditor: FC<{
  criterion: ClassifierChoiceCriterionData;
  index: number;
  criteriaType: 'lines' | 'object';
  node: ChartNode;
  isDisabled: boolean;
  isReadonly: boolean;
  onClose?: () => void;
  onChange: (criterion: ClassifierChoiceCriterionData) => void;
  onDelete: () => void;
}> = ({ criterion, index, criteriaType, node, isDisabled, isReadonly, onClose, onChange, onDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: criterion.id!,
    disabled: isDisabled || isReadonly,
  });
  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };
  const setLines = (lines: string[]) => onChange({ ...criterion, lines });

  return (
    <div ref={setNodeRef} style={style} className={`choice-criterion${isDragging ? ' dragging' : ''}`}>
      <button type="button" className="choice-criterion-drag" aria-label="Reorder criterion" {...attributes} {...listeners}>
        ⋮⋮
      </button>
      <div className="choice-criterion-fields">
        <TextField
          value={criterion.key}
          aria-label={`Criterion ${index + 1} name`}
          placeholder="Name"
          isDisabled={isDisabled}
          isReadOnly={isReadonly}
          onChange={(event) => onChange({ ...criterion, key: event.currentTarget.value })}
        />
        {criteriaType === 'lines' ? (
          <div className="choice-criterion-lines" role="group" aria-label={`Criterion ${index + 1} lines`}>
            {criterion.lines.map((line, lineIndex) => (
              <div className="choice-criterion-line" key={lineIndex}>
                <TextField
                  value={line}
                  aria-label={`Criterion ${index + 1} line ${lineIndex + 1}`}
                  placeholder="Line"
                  isDisabled={isDisabled}
                  isReadOnly={isReadonly}
                  onChange={(event) =>
                    setLines(
                      criterion.lines.map((existing, existingIndex) =>
                        existingIndex === lineIndex ? event.currentTarget.value : existing,
                      ),
                    )
                  }
                />
                <Button
                  className="choice-criterion-line-delete"
                  appearance="subtle"
                  aria-label={`Delete criterion ${index + 1} line ${lineIndex + 1}`}
                  isDisabled={isDisabled || isReadonly || criterion.lines.length <= 1}
                  onClick={() => setLines(criterion.lines.filter((_, existingIndex) => existingIndex !== lineIndex))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button appearance="default" isDisabled={isDisabled || isReadonly} onClick={() => setLines([...criterion.lines, ''])}>
              Add line
            </Button>
          </div>
        ) : (
          <CodeEditor
            value={criterion.objectTemplate ?? '{}'}
            onChange={(objectTemplate) => onChange({ ...criterion, objectTemplate })}
            isReadonly={isReadonly}
            isDisabled={isDisabled}
            label=""
            name={`choiceCriterionObject-${index}`}
            language="json"
            interpolationSyntax="json-template"
            theme="prompt-interpolation"
            enableFolding
            id={node.id}
            nodeType={node.type}
            defaultHeight={200}
            onClose={onClose}
          />
        )}
      </div>
      <Button
        className="choice-criterion-delete"
        appearance="subtle"
        aria-label={`Delete criterion ${index + 1}`}
        onClick={onDelete}
        isDisabled={isDisabled || isReadonly}
      >
        ×
      </Button>
    </div>
  );
};
