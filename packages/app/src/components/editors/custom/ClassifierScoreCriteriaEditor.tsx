import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import {
  type ChartNode,
  type ClassifierQuestionNodeData,
  type ClassifierScoreCriterionData,
  type CustomEditorDefinition,
} from '@valerypopoff/rivet2-core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { css } from '@emotion/react';
import { isEqual } from 'lodash-es';
import { type CSSProperties, type FC, useEffect, useRef } from 'react';
import { type SharedEditorProps } from '../SharedEditorProps';
import { CodeEditor } from '../CodeEditor';

const styles = css`
  min-width: 0;

  .score-criteria-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .score-criteria-content.compact-text {
    gap: 8px;
  }

  .score-text-criterion {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) 32px;
    gap: 8px;
    align-items: center;
  }

  .score-text-criterion.dragging {
    z-index: 2;
  }

  .score-criterion {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) 32px;
    gap: 8px;
    align-items: start;
    padding: 12px;
    border: 1px solid var(--settings-collapsible-border);
    border-radius: 8px;
    background: var(--settings-collapsible-header-bg);
  }

  .score-criterion.dragging {
    z-index: 2;
  }

  .score-criterion-editor {
    min-width: 0;
  }

  .score-criterion-editor > *:not(:last-child),
  .score-criterion-lines > *:not(:last-child) {
    margin-bottom: 8px;
  }

  .score-criterion-line {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .score-criterion-line > div:first-of-type {
    flex: 1;
  }

  .score-criterion-drag {
    width: 28px;
    height: 32px;
    border: 0;
    background: transparent;
    color: var(--foreground-muted);
    cursor: grab;
    touch-action: none;
  }

  .score-criterion-delete,
  .score-criterion-line-delete {
    min-width: 32px;
    padding: 0;
  }

  .score-criteria-add {
    align-self: flex-start;
    min-width: 120px;
    justify-content: center;
  }
`;

function createCriterion(): ClassifierScoreCriterionData {
  return {
    id: globalThis.crypto.randomUUID(),
    type: 'text',
    text: '',
    lines: [''],
    objectTemplate: '{}',
  };
}

function resolveCriteria(data: ClassifierQuestionNodeData): ClassifierScoreCriterionData[] {
  if (data.scoreCriteria) {
    return data.scoreCriteria.map((criterion, index) => ({ ...criterion, id: criterion.id ?? `legacy-${index}` }));
  }
  return (data.levels ?? ['', '']).map((text, index) => ({ ...createCriterion(), id: `legacy-${index}`, text }));
}

type Props = SharedEditorProps & { editor: CustomEditorDefinition<ChartNode> };

export const ClassifierScoreCriteriaEditor: FC<Props> = (props) => {
  const { node, onChange, isDisabled, isReadonly, onClose } = props;
  const data = node.data as ClassifierQuestionNodeData;
  const criteria = resolveCriteria(data);
  const criteriaType = data.criteriaType ?? 'text';
  const mounted = useRef(true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const commit = (next: ClassifierScoreCriterionData[]) => {
    if (!mounted.current || isEqual(criteria, next)) return;
    onChange({ ...node, data: { ...data, scoreCriteria: next } });
  };
  const update = (index: number, next: ClassifierScoreCriterionData) => {
    const current = criteria[index];
    if (!current || isEqual(current, next)) return;
    commit(criteria.map((criterion, criterionIndex) => (criterionIndex === index ? next : criterion)));
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = criteria.findIndex((criterion) => criterion.id === active.id);
    const to = criteria.findIndex((criterion) => criterion.id === over.id);
    if (from < 0 || to < 0) return;
    commit(arrayMove(criteria, from, to));
  };

  return (
    <div css={styles}>
      <div className={`score-criteria-content${criteriaType === 'text' ? ' compact-text' : ''}`}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={criteria.map((criterion) => criterion.id!)} strategy={verticalListSortingStrategy}>
            {criteria.map((criterion, index) => (
              criteriaType === 'text' ? (
                <ScoreTextCriterionEditor
                  key={criterion.id}
                  criterion={criterion}
                  index={index}
                  isDisabled={isDisabled}
                  isReadonly={isReadonly}
                  onChange={(next) => update(index, next)}
                  onDelete={() => commit(criteria.filter((_, criterionIndex) => criterionIndex !== index))}
                />
              ) : (
                <ScoreCriterionEditor
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
              )
            ))}
          </SortableContext>
        </DndContext>
        <Button
          className="score-criteria-add"
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

const ScoreTextCriterionEditor: FC<{
  criterion: ClassifierScoreCriterionData;
  index: number;
  isDisabled: boolean;
  isReadonly: boolean;
  onChange: (criterion: ClassifierScoreCriterionData) => void;
  onDelete: () => void;
}> = ({ criterion, index, isDisabled, isReadonly, onChange, onDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: criterion.id!,
    disabled: isDisabled || isReadonly,
  });
  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} className={`score-text-criterion${isDragging ? ' dragging' : ''}`}>
      <button type="button" className="score-criterion-drag" aria-label="Reorder criterion" {...attributes} {...listeners}>
        ⋮⋮
      </button>
      <TextField
        value={criterion.text}
        aria-label={`Criterion ${index + 1}`}
        placeholder="Name"
        isDisabled={isDisabled}
        isReadOnly={isReadonly}
        onChange={(event) => onChange({ ...criterion, text: event.currentTarget.value })}
      />
      <Button
        className="score-criterion-delete"
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

const ScoreCriterionEditor: FC<{
  criterion: ClassifierScoreCriterionData;
  index: number;
  criteriaType: 'lines' | 'object';
  node: ChartNode;
  isDisabled: boolean;
  isReadonly: boolean;
  onClose?: () => void;
  onChange: (criterion: ClassifierScoreCriterionData) => void;
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
    <div ref={setNodeRef} style={style} className={`score-criterion${isDragging ? ' dragging' : ''}`}>
      <button type="button" className="score-criterion-drag" aria-label="Reorder criterion" {...attributes} {...listeners}>
        ⋮⋮
      </button>
      <div className="score-criterion-editor">
        {criteriaType === 'lines' && (
          <div className="score-criterion-lines" role="group" aria-label={`Criterion ${index + 1} lines`}>
            {criterion.lines.map((line, lineIndex) => (
              <div className="score-criterion-line" key={lineIndex}>
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
                  className="score-criterion-line-delete"
                  appearance="subtle"
                  aria-label={`Delete criterion ${index + 1} line ${lineIndex + 1}`}
                  isDisabled={isDisabled || isReadonly || criterion.lines.length <= 1}
                  onClick={() => setLines(criterion.lines.filter((_, existingIndex) => existingIndex !== lineIndex))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              appearance="default"
              isDisabled={isDisabled || isReadonly}
              onClick={() => setLines([...criterion.lines, ''])}
            >
              Add line
            </Button>
          </div>
        )}
        {criteriaType === 'object' && (
          <CodeEditor
            value={criterion.objectTemplate ?? '{}'}
            onChange={(objectTemplate) => onChange({ ...criterion, objectTemplate })}
            isReadonly={isReadonly}
            isDisabled={isDisabled}
            label=""
            name={`scoreCriterionObject-${index}`}
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
        className="score-criterion-delete"
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
