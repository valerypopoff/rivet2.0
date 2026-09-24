import {
  type GraphSelectorEditorDefinition,
  type ChartNode,
  type GraphId,
  type NodeGraph,
} from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { Field, HelperMessage } from '@atlaskit/form';
import Select from '@atlaskit/select';
import { useAtomValue } from 'jotai';
import { projectState } from '../../state/savedGraphs';
import { getHelperMessage } from './editorUtils';
import { getProjectGraphSelectorOptions } from '../../utils/graphSelectorOptions';
import { createFoldersFromGraphs, type NodeGraphFolderItem } from '../graphList/graphFolders';
import { OpenFolderIcon } from '../graphList/OpenFolderIcon';

export type HierarchicalGraphOption = {
  value: string;
  label: string;
  kind: 'folder' | 'graph';
  graphId?: GraphId;
  depth: number;
  searchText: string;
  isDisabled?: boolean;
};

/** Keep selector order and folder names aligned with the graph panel. */
export function getHierarchicalGraphOptions(graphs: Record<GraphId, NodeGraph>): HierarchicalGraphOption[] {
  const graphIds = new Map(Object.entries(graphs).map(([id, graph]) => [graph, id as GraphId]));
  const visit = (items: NodeGraphFolderItem[], depth: number, path: string): HierarchicalGraphOption[] => {
    const options: HierarchicalGraphOption[] = [];
    for (const item of items) {
      const fullPath = path ? `${path}/${item.name}` : item.name;
      if (item.type === 'folder') {
        const children = visit(item.children, depth + 1, fullPath);
        options.push({
          value: `folder:${fullPath}`,
          label: item.name,
          kind: 'folder',
          depth,
          searchText: `${fullPath} ${children.map((child) => child.searchText).join(' ')}`,
          isDisabled: true,
        });
        options.push(...children);
      } else {
        const graphId = (item.graph.metadata?.id ?? graphIds.get(item.graph)) as GraphId | undefined;
        if (!graphId) continue;
        options.push({
          value: `graph:${graphId}`,
          label: item.name || graphId,
          kind: 'graph',
          graphId,
          depth,
          searchText: `${fullPath} ${graphId}`,
        });
      }
    }
    return options;
  };
  return visit(createFoldersFromGraphs(Object.values(graphs), []), 0, '');
}

export const DefaultGraphSelectorEditor: FC<
  SharedEditorProps & {
    editor: GraphSelectorEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);

  return (
    <GraphSelector
      value={data[editor.dataKey] as GraphId | undefined}
      isReadonly={isReadonly || isDisabled}
      onChange={(selected) =>
        onChange({
          ...node,
          data: {
            ...data,
            [editor.dataKey]: selected,
          },
        })
      }
      label={editor.label}
      name={editor.dataKey}
      helperMessage={helperMessage}
    />
  );
};

export const GraphSelector: FC<{
  value: GraphId | undefined;
  name: string;
  label: string;
  isReadonly: boolean;
  onChange?: (selected: GraphId) => void;
  helperMessage?: string;
}> = ({ value, isReadonly, onChange, label, name, helperMessage }) => {
  return (
    <Field name={name} label={label} isDisabled={isReadonly}>
      {({ fieldProps }) => (
        <>
          {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
          <GraphSelectorSelect {...fieldProps} value={value} isReadonly={isReadonly} onChange={onChange} />
        </>
      )}
    </Field>
  );
};

export const GraphSelectorSelect: FC<{
  value: GraphId | undefined;
  isReadonly?: boolean;
  onChange?: (selected: GraphId) => void;
  ariaLabel?: string;
  className?: string;
  includeMissingSelectedGraph?: boolean;
  hierarchical?: boolean;
}> = ({
  value,
  isReadonly,
  onChange,
  ariaLabel,
  className,
  includeMissingSelectedGraph = false,
  hierarchical = false,
}) => {
  const project = useAtomValue(projectState);
  if (hierarchical) {
    const options = getHierarchicalGraphOptions(project.graphs);
    if (includeMissingSelectedGraph && value && !options.some((option) => option.graphId === value)) {
      options.unshift({
        value: `graph:${value}`,
        label: `Missing graph: ${value}`,
        kind: 'graph',
        graphId: value,
        depth: 0,
        searchText: value,
        isDisabled: true,
      });
    }
    return (
      <Select
        aria-label={ariaLabel}
        className={className}
        isDisabled={isReadonly}
        isSearchable
        options={options}
        value={options.find((option) => option.graphId === value) ?? null}
        onChange={(selected) => {
          if (selected?.kind === 'graph' && selected.graphId && !selected.isDisabled) onChange?.(selected.graphId);
        }}
        filterOption={(candidate, input) =>
          candidate.data.searchText.toLocaleLowerCase().includes(input.toLocaleLowerCase())
        }
        formatOptionLabel={(option) => (
          <span style={{ alignItems: 'center', display: 'inline-flex', gap: 4, paddingLeft: option.depth * 12 }}>
            {option.kind === 'folder' && <OpenFolderIcon width={14} height={14} aria-hidden="true" />}
            <span>{option.label}</span>
          </span>
        )}
        placeholder="Select Graph..."
      />
    );
  }
  const graphOptions = getProjectGraphSelectorOptions(project.graphs, {
    includeMissingSelectedGraph,
    selectedGraphId: value,
  });

  const selectedOption = graphOptions.find((option) => option.value === value);

  return (
    <Select
      aria-label={ariaLabel}
      className={className}
      isDisabled={isReadonly}
      isSearchable
      options={graphOptions}
      value={selectedOption ?? null}
      onChange={(selected) => {
        if (selected) {
          onChange?.(selected.value);
        }
      }}
      placeholder="Select Graph..."
    />
  );
};
