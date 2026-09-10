import Button from '@atlaskit/button';
import { Field } from '@atlaskit/form';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import TextArea from '@atlaskit/textarea';
import TextField from '@atlaskit/textfield';
import { css } from '@emotion/react';
import {
  decodeProjectGlobalVariable,
  encodeProjectGlobalVariable,
  getDefaultValue,
  type ProjectGlobalVariableDefinition,
  type ProjectGlobalVariables,
  type ScalarOrArrayDataType,
} from '@valerypopoff/rivet2-core';
import { useAtom } from 'jotai';
import { useEffect, useMemo, useState, type FC } from 'react';
import { projectState } from '../state/savedGraphs.js';
import { AppModalHeader } from './AppModalHeader.js';
import { DataTypeSelector } from './editors/DataTypeEditor.js';
import { FieldHelperMessage } from './FieldHelperMessage.js';

const styles = css`
  .project-global-variables-intro,
  .project-global-variables-empty {
    margin: 0 0 16px;
    color: var(--grey-light);
    line-height: 1.4;
  }

  .project-global-variables-heading {
    margin: 0 0 6px;
    color: var(--foreground-muted);
    font-weight: var(--font-weight-semibold);
  }

  .project-global-variables-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }

  .project-global-variables-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border: 1px solid var(--grey-dark);
    border-radius: 4px;
    padding: 8px 12px;
  }

  .project-global-variables-summary {
    min-width: 0;
  }

  .project-global-variables-id {
    font-weight: var(--font-weight-semibold);
    overflow-wrap: anywhere;
  }

  .project-global-variables-value {
    color: var(--grey-light);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .project-global-variables-edit-actions {
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  }

  .project-global-variables-error {
    color: var(--error-light);
  }

  .project-global-variables-modal-copy {
    margin-top: 0;
    color: var(--grey-light);
    line-height: 1.4;
  }

  .project-global-variables-json textarea {
    font-family: var(--font-family-monospace);
    min-height: 160px;
    resize: vertical;
  }
`;

const footerStyles = css`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`;

const emptyProjectGlobalVariables: ProjectGlobalVariables = {};

type EditingProjectGlobalVariable = {
  projectId: string;
  id?: string;
  definition?: ProjectGlobalVariableDefinition;
};

type ProjectGlobalVariableEditorModalProps = {
  editing: EditingProjectGlobalVariable | undefined;
  existingIds: readonly string[];
  onClose: () => void;
  onDelete: (projectId: string, id: string) => boolean;
  onSave: (
    projectId: string,
    id: string,
    previousId: string | undefined,
    definition: ProjectGlobalVariableDefinition,
  ) => boolean;
};

type ProjectGlobalVariableEditorModalContentsProps = Omit<ProjectGlobalVariableEditorModalProps, 'editing'> & {
  editing: EditingProjectGlobalVariable;
};

function stringifyLiteral(definition: ProjectGlobalVariableDefinition): string {
  return JSON.stringify(definition.value, null, 2);
}

function defaultDefinition(type: ScalarOrArrayDataType = 'string'): ProjectGlobalVariableDefinition {
  return encodeProjectGlobalVariable({ type, value: getDefaultValue(type) } as Parameters<
    typeof encodeProjectGlobalVariable
  >[0]);
}

function withProjectGlobalVariable(
  definitions: ProjectGlobalVariables | undefined,
  id: string,
  definition: ProjectGlobalVariableDefinition,
): ProjectGlobalVariables {
  // Computed properties create own data properties, including for __proto__.
  return { ...(definitions ?? {}), [id]: definition };
}

function withoutProjectGlobalVariable(
  definitions: ProjectGlobalVariables | undefined,
  id: string,
): ProjectGlobalVariables {
  const { [id]: _removed, ...remaining } = definitions ?? {};
  return remaining;
}

export const ProjectGlobalVariablesConfiguration: FC = () => {
  const [project, setProject] = useAtom(projectState);
  const [editing, setEditing] = useState<EditingProjectGlobalVariable>();
  const definitions = project.metadata.globalVariables ?? emptyProjectGlobalVariables;
  const entries = useMemo(
    () => Object.entries(definitions).sort(([left], [right]) => left.localeCompare(right)),
    [definitions],
  );

  useEffect(() => {
    if (editing?.projectId !== undefined && editing.projectId !== project.metadata.id) {
      setEditing(undefined);
    }
  }, [editing?.projectId, project.metadata.id]);

  const save = (
    ownerProjectId: string,
    id: string,
    previousId: string | undefined,
    definition: ProjectGlobalVariableDefinition,
  ): boolean => {
    let saved = false;
    setProject((current) => {
      if (current.metadata.id !== ownerProjectId) return current;
      const currentDefinitions = current.metadata.globalVariables;
      if (
        (previousId !== undefined && !Object.hasOwn(currentDefinitions ?? {}, previousId)) ||
        (previousId !== id && Object.hasOwn(currentDefinitions ?? {}, id))
      ) {
        return current;
      }
      const globalVariables =
        previousId !== undefined && previousId !== id
          ? withoutProjectGlobalVariable(currentDefinitions, previousId)
          : currentDefinitions;
      saved = true;
      return {
        ...current,
        metadata: {
          ...current.metadata,
          globalVariables: withProjectGlobalVariable(globalVariables, id, definition),
        },
      };
    });
    if (saved) setEditing(undefined);
    return saved;
  };

  const remove = (ownerProjectId: string, id: string): boolean => {
    let removed = false;
    setProject((current) => {
      if (current.metadata.id !== ownerProjectId || !Object.hasOwn(current.metadata.globalVariables ?? {}, id))
        return current;
      const globalVariables = withoutProjectGlobalVariable(current.metadata.globalVariables, id);
      removed = true;
      return {
        ...current,
        metadata: {
          ...current.metadata,
          globalVariables: Object.keys(globalVariables).length > 0 ? globalVariables : undefined,
        },
      };
    });
    if (removed) setEditing(undefined);
    return removed;
  };

  return (
    <div css={styles}>
      <div className="project-global-variables-heading">Global variables</div>
      <p className="project-global-variables-intro">
        These are the same global variables used by <b>Set Global</b> and <b>Get Global</b>. They are assigned
        automatically when the project runs, before any nodes execute. <b>Set Global</b> can replace a value during
        that run.
      </p>
      {entries.length ? (
        <div className="project-global-variables-list">
          {entries.map(([id, definition]) => (
            <div className="project-global-variables-row" key={id}>
              <div className="project-global-variables-summary">
                <div className="project-global-variables-id">{id}</div>
                <div className="project-global-variables-value">
                  {definition.type}: {stringifyLiteral(definition)}
                </div>
              </div>
              <div className="project-global-variables-edit-actions">
                <Button
                  appearance="subtle"
                  onClick={() => setEditing({ projectId: project.metadata.id, id, definition })}
                >
                  Edit
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="project-global-variables-empty">No global variables configured for this project.</p>
      )}
      <Button onClick={() => setEditing({ projectId: project.metadata.id, definition: defaultDefinition() })}>
        Add global variable
      </Button>
      <ProjectGlobalVariableEditorModal
        editing={editing}
        existingIds={Object.keys(definitions)}
        onClose={() => setEditing(undefined)}
        onDelete={remove}
        onSave={save}
      />
    </div>
  );
};

const ProjectGlobalVariableEditorModal: FC<ProjectGlobalVariableEditorModalProps> = ({
  editing,
  existingIds,
  onClose,
  onDelete,
  onSave,
}) => (
  <ModalTransition>
    {editing && (
      <ProjectGlobalVariableEditorModalContents
        editing={editing}
        existingIds={existingIds}
        onClose={onClose}
        onDelete={onDelete}
        onSave={onSave}
      />
    )}
  </ModalTransition>
);

const ProjectGlobalVariableEditorModalContents: FC<ProjectGlobalVariableEditorModalContentsProps> = ({
  editing,
  existingIds,
  onClose,
  onDelete,
  onSave,
}) => {
  const initialDefinition = editing.definition ?? defaultDefinition();
  const [id, setId] = useState(editing.id ?? '');
  const [dataType, setDataType] = useState<ScalarOrArrayDataType>(initialDefinition.type);
  const [literal, setLiteral] = useState(() => stringifyLiteral(initialDefinition));
  const [error, setError] = useState<string>();
  const normalizedId = id.trim();
  const idAlreadyExists = normalizedId !== '' && normalizedId !== editing.id && existingIds.includes(normalizedId);
  const canSave = normalizedId !== '' && !idAlreadyExists;

  const changeDataType = (nextType: ScalarOrArrayDataType | undefined) => {
    if (!nextType) return;
    setDataType(nextType);
    setLiteral(stringifyLiteral(defaultDefinition(nextType)));
    setError(undefined);
  };

  const save = () => {
    if (!canSave) return;
    try {
      const parsed = JSON.parse(literal) as unknown;
      // Decode first for a precise user-facing error, then encode again so
      // project metadata always receives the canonical portable form.
      const decoded = decodeProjectGlobalVariable(
        { type: dataType, value: parsed },
        `Global variable "${normalizedId}"`,
      );
      if (!onSave(editing.projectId, normalizedId, editing.id, encodeProjectGlobalVariable(decoded))) {
        setError('This global variable changed in another edit. Reopen it and try again.');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Modal onClose={onClose} width="medium" testId="project-global-variable-editor-modal">
      <AppModalHeader title={editing.id === undefined ? 'Add Global Variable' : 'Edit Global Variable'} />
      <ModalBody>
        <div css={styles}>
          <p className="project-global-variables-modal-copy">
            This global variable is saved with the project and assigned automatically at the start of each project
            run. Values use JSON. Binary values and special values use Rivet portable markers so they remain valid in
            project files and every executor.
          </p>
          <Field name="project-global-variable-id" label="ID" isRequired>
            {({ fieldProps }) => (
              <TextField
                {...fieldProps}
                value={id}
                placeholder="global-name"
                onChange={(event) => {
                  fieldProps.onChange(event);
                  setId((event.target as HTMLInputElement).value);
                }}
              />
            )}
          </Field>
          {idAlreadyExists && (
            <FieldHelperMessage className="project-global-variables-error">This ID already exists.</FieldHelperMessage>
          )}
          <DataTypeSelector
            value={dataType}
            onChange={(nextType) => changeDataType(nextType as ScalarOrArrayDataType | undefined)}
            isDisabled={false}
            isReadonly={false}
          />
          <Field name="project-global-variable-value" label="Value (JSON)">
            {({ fieldProps }) => (
              <div className="project-global-variables-json">
                <TextArea
                  {...fieldProps}
                  value={literal}
                  onChange={(event) => {
                    const nextLiteral = (event.target as HTMLTextAreaElement).value;
                    fieldProps.onChange(nextLiteral);
                    setLiteral(nextLiteral);
                    setError(undefined);
                  }}
                />
              </div>
            )}
          </Field>
          {error && <FieldHelperMessage className="project-global-variables-error">{error}</FieldHelperMessage>}
        </div>
      </ModalBody>
      <ModalFooter>
        <div css={footerStyles}>
          <Button onClick={onClose}>Cancel</Button>
          {editing.id !== undefined && (
            <Button
              appearance="danger"
              onClick={() => {
                if (!onDelete(editing.projectId, editing.id!)) {
                  setError('This global variable changed in another edit. Reopen it and try again.');
                }
              }}
            >
              Delete
            </Button>
          )}
          <Button appearance="primary" isDisabled={!canSave} onClick={save}>
            Save
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
};
