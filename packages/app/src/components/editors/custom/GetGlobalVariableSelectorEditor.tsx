import { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { css } from '@emotion/react';
import type { ChartNode, CustomEditorDefinition } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { type FC, useId, useMemo, useState } from 'react';
import { graphState, projectState, referencedProjectsState } from '../editorWorkflowState.js';
import type { SharedEditorProps } from '../SharedEditorProps';
import { getGlobalVariableOptions, getGlobalVariableTypeSuggestion } from './globalVariableOptions.js';

type Props = SharedEditorProps & {
  editor: CustomEditorDefinition<ChartNode>;
};

const variableIdSuggestionsCss = css`
  position: relative;

  .variable-id-suggestions {
    position: absolute;
    z-index: 10;
    top: calc(100% + 4px);
    width: 100%;
    max-height: 200px;
    overflow-y: auto;
    padding: 4px;
    border: 1px solid color-mix(in srgb, var(--foreground-bright) 20%, transparent);
    border-radius: 4px;
    background: var(--node-body-bg);
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.35);
  }

  .variable-id-suggestion {
    display: block;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--foreground-bright);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .variable-id-suggestion:hover,
  .variable-id-suggestion[aria-selected='true'] {
    background: color-mix(in srgb, var(--primary) 18%, var(--node-body-bg));
  }
`;

export const GetGlobalVariableSelectorEditor: FC<Props> = ({ node, onChange, isReadonly, isDisabled, editor }) => {
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const referencedProjects = useAtomValue(referencedProjectsState);
  const data = node.data as Record<string, unknown>;
  const variableId = typeof data.id === 'string' ? data.id : '';
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const menuId = useId();
  const isUnavailable = isReadonly || isDisabled;
  const options = useMemo(
    () => getGlobalVariableOptions(project, graph, referencedProjects),
    [graph, project, referencedProjects],
  );
  const suggestions = options.filter((option) => option.value.toLowerCase().includes(variableId.toLowerCase()));
  const setVariableId = (id: string) => {
    const suggestion = data.useIdInput || !options.some((option) => option.value === id)
      ? undefined
      : getGlobalVariableTypeSuggestion(id, project, graph, referencedProjects);
    const nextData: Record<string, unknown> = { ...data, id };
    delete nextData.typeSuggestion;
    if (suggestion) {
      nextData.dataType = suggestion.type;
      nextData.typeSuggestion = { id, ...suggestion };
    }
    onChange({
      ...node,
      data: nextData,
    });
  };
  const showSuggestions = !isUnavailable && isOpen && suggestions.length > 0;
  const closeSuggestions = () => {
    setIsOpen(false);
    setActiveIndex(-1);
  };
  const chooseSuggestion = (id: string) => {
    if (isUnavailable) return;
    setVariableId(id);
    closeSuggestions();
  };

  return (
    <Field name="id" label={editor.label} isDisabled={isUnavailable}>
      {({ fieldProps }) => (
        <div css={variableIdSuggestionsCss}>
          <TextField
            {...fieldProps}
            id="get-global-variable-id"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={showSuggestions ? menuId : undefined}
            aria-expanded={showSuggestions}
            aria-activedescendant={showSuggestions && activeIndex >= 0 ? `${menuId}-${activeIndex}` : undefined}
            value={variableId}
            autoFocus={editor.autoFocus}
            autoComplete="off"
            spellCheck={false}
            isDisabled={isUnavailable}
            placeholder="Type or search global variables..."
            onFocus={() => {
              setActiveIndex(-1);
              setIsOpen(true);
            }}
            onClick={() => {
              setActiveIndex(-1);
              setIsOpen(true);
            }}
            onBlur={() => {
              fieldProps.onBlur();
              closeSuggestions();
            }}
            onChange={(event) => {
              setVariableId((event.target as HTMLInputElement).value);
              setActiveIndex(-1);
              setIsOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIsOpen(true);
                setActiveIndex((index) => (showSuggestions ? (index + 1) % suggestions.length : 0));
              } else if (event.key === 'ArrowUp' && showSuggestions) {
                event.preventDefault();
                setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
              } else if (event.key === 'Enter' && showSuggestions) {
                event.preventDefault();
                if (activeIndex >= 0) {
                  const suggestion = suggestions[activeIndex];
                  if (suggestion) chooseSuggestion(suggestion.value);
                } else {
                  closeSuggestions();
                }
              } else if (event.key === 'Escape' && isOpen) {
                event.stopPropagation();
                closeSuggestions();
              }
            }}
          />
          {showSuggestions && (
            <div id={menuId} className="variable-id-suggestions" role="listbox" aria-label="Known variable IDs">
              {suggestions.map((option, index) => (
                <button
                  key={option.value}
                  id={`${menuId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className="variable-id-suggestion"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSuggestion(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Field>
  );
};
