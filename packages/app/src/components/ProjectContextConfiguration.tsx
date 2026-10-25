import { css } from '@emotion/react';
import Button from '@atlaskit/button';
import { Field } from '@atlaskit/form';
import Modal, { ModalTransition, ModalBody, ModalFooter } from '@atlaskit/modal-dialog';
import TextField from '@atlaskit/textfield';
import { type DataValue } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue } from 'jotai';
import { type FC, useEffect, useMemo, useState } from 'react';
import { useToggle } from 'ahooks';
import { projectContextState, projectState } from '../state/savedGraphs.js';
import { flushHybridStorageGroup } from '../state/storage.js';
import { handleError } from '../utils/errorHandling.js';
import { entries } from '../utils/typeSafety.js';
import { AppModalHeader } from './AppModalHeader.js';
import { FieldHelperMessage } from './FieldHelperMessage.js';

const projectContextSettingsPageStyles = css`
  .project-context-intro {
    margin: 0 0 16px;
    color: var(--grey-light);
    line-height: 1.4;
  }

  .context-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }

  .context-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--grey-darkish);
    border-left: 2px solid var(--grey-darkish);
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .key {
    font-weight: bold;
    overflow-wrap: anywhere;
  }

  .value {
    color: var(--grey-light);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .actions {
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  }

  .empty-context-list {
    margin: 0 0 16px;
    color: var(--grey-light);
  }

  .project-context-field-error {
    color: var(--error-light);
  }
`;

const modalFooterActionsStyles = css`
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  gap: 8px;
`;

type ContextValue = {
  key: string;
  previousKey?: string;
  value: DataValue;
};

function persistProjectContextValues(): void {
  void flushHybridStorageGroup('project').catch((error) => {
    handleError(error, 'Failed to persist project context values', { toastError: false });
  });
}

export const ProjectContextConfiguration: FC = () => {
  const project = useAtomValue(projectState);
  const [projectContext, setProjectContext] = useAtom(projectContextState(project.metadata.id));
  const [projectEditContextModalOpen, { setLeft: closeContextEditor, setRight: openContextEditor }] = useToggle(false);
  const [editContextData, setEditContextData] = useState<ContextValue>();
  const editTargetAvailable = editContextData === undefined || Object.hasOwn(projectContext, editContextData.key);

  useEffect(() => {
    if (!editTargetAvailable) {
      closeContextEditor();
      setEditContextData(undefined);
    }
  }, [editTargetAvailable, closeContextEditor]);

  const sortedContext = useMemo(() => {
    return entries(projectContext).sort(([a], [b]) => a.localeCompare(b));
  }, [projectContext]);

  const contextKeys = useMemo(() => sortedContext.map(([key]) => key), [sortedContext]);

  const setProjectContextValue = ({ key, previousKey, value }: ContextValue) => {
    setProjectContext((context) => {
      const next = { ...context, [key]: { value } };
      if (previousKey !== undefined && previousKey !== key) delete next[previousKey];
      return next;
    });
    persistProjectContextValues();
    closeContextEditor();
    setEditContextData(undefined);
  };

  const deleteProjectContextValue = (key: string) => {
    setProjectContext((context) => {
      const next = { ...context };
      delete next[key];
      return next;
    });
    persistProjectContextValues();
    closeContextEditor();
    setEditContextData(undefined);
  };

  const editContextValue = (value: ContextValue) => {
    setEditContextData(value);
    openContextEditor();
  };

  const addContextValue = () => {
    setEditContextData(undefined);
    openContextEditor();
  };

  return (
    <div css={projectContextSettingsPageStyles}>
      <p className="project-context-intro">
        Context values are environment-style values stored in the app for each project. They are not written to the
        project file, so sharing the project file does not share these values. A <b>Context</b> node can read these
        values while running graphs in the current project.
      </p>
      {sortedContext.length > 0 ? (
        <div className="context-list">
          {sortedContext.map(([key, value]) => (
            <div className="context-list-item" key={key}>
              <div className="info">
                <span className="key">{key || '(No ID)'}</span>
                <span className="value">{value.value.value as string}</span>
              </div>
              <div className="actions">
                <Button appearance="link" onClick={() => editContextValue({ key, value: value.value })}>
                  Edit
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-context-list">No context values configured for this project.</p>
      )}
      <Button appearance="default" onClick={addContextValue}>
        Add Context Value
      </Button>
      <ValueEditorModalRenderer
        isOpen={projectEditContextModalOpen && editTargetAvailable}
        onClose={closeContextEditor}
        initialKey={editContextData?.key}
        initialValue={editContextData?.value}
        existingKeys={contextKeys}
        onSave={setProjectContextValue}
        onDelete={deleteProjectContextValue}
      />
    </div>
  );
};

const ValueEditorModalRenderer: FC<{
  initialKey?: string;
  initialValue?: DataValue;
  existingKeys: readonly string[];
  isOpen: boolean;
  onSave: (value: ContextValue) => void;
  onDelete: (key: string) => void;
  onClose: () => void;
}> = ({ initialKey, initialValue, existingKeys, isOpen, onClose, onSave, onDelete }) => {
  return (
    <ModalTransition>
      {isOpen && (
        <ValueEditorModal
          initialKey={initialKey}
          initialValue={initialValue}
          existingKeys={existingKeys}
          onSave={onSave}
          onDelete={onDelete}
          onClose={onClose}
        />
      )}
    </ModalTransition>
  );
};

const ValueEditorModal: FC<{
  initialKey?: string;
  initialValue?: DataValue;
  existingKeys: readonly string[];
  onSave: (value: ContextValue) => void;
  onDelete: (key: string) => void;
  onClose: () => void;
}> = ({ initialKey, initialValue, existingKeys, onSave, onDelete, onClose }) => {
  const [key, setKey] = useState(initialKey ?? '');
  const [value, setValue] = useState((initialValue?.value as string | undefined) ?? '');
  const hasExistingKey = initialKey !== undefined;
  const hasEditableLegacyBlankKey = hasExistingKey && initialKey.trim().length === 0;
  const contextKey = key.trim();
  const contextKeyAlreadyExists =
    contextKey.length > 0 && contextKey !== initialKey && existingKeys.includes(contextKey);
  const canSave = contextKey.length > 0 && !contextKeyAlreadyExists;

  const handleDelete = () => {
    if (hasExistingKey) {
      onDelete(initialKey);
      return;
    }

    onClose();
  };

  const handleSave = () => {
    if (!canSave) {
      return;
    }

    const dataValue: DataValue = {
      type: 'string',
      value,
    };
    onSave({ key: contextKey, previousKey: initialKey, value: dataValue });
  };

  return (
    <Modal onClose={onClose}>
      <AppModalHeader title={hasExistingKey ? 'Edit Context Value' : 'Add Context Value'} />
      <ModalBody>
        <form
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSave();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <p>
            Context values are accessible in any graph in the project. Use a Context node to retrieve a value from the
            context during graph execution.
          </p>
          <Field name="key" label="ID" isRequired>
            {() => (
              <TextField
                placeholder="Context ID"
                value={key}
                isRequired
                onChange={(e) => setKey((e.target as HTMLInputElement).value)}
                isDisabled={hasExistingKey && !hasEditableLegacyBlankKey}
              />
            )}
          </Field>
          {contextKeyAlreadyExists && (
            <FieldHelperMessage className="project-context-field-error">
              A context value with this ID already exists.
            </FieldHelperMessage>
          )}
          <Field name="value" label="Value">
            {() => (
              <TextField
                placeholder="Value"
                value={value}
                onChange={(e) => setValue((e.target as HTMLInputElement).value)}
              />
            )}
          </Field>
        </form>
      </ModalBody>
      <ModalFooter>
        <div css={modalFooterActionsStyles}>
          <Button appearance="default" onClick={onClose}>
            Cancel
          </Button>
          {hasExistingKey && (
            <Button appearance="danger" onClick={handleDelete}>
              Delete
            </Button>
          )}
          <Button appearance="primary" isDisabled={!canSave} onClick={handleSave}>
            Save
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
};
