import { createContext, useContext } from 'react';
import styled from '@emotion/styled';
import type { NodeId } from '@valerypopoff/rivet2-core';
import type { NodePrefabUsage } from '../../domain/nodeLibrary/nodePrefabs.js';

export const NodeLibraryReferencesContext = createContext<{
  usages: ReadonlyMap<NodeId, readonly NodePrefabUsage[]>;
  onNavigate: (usage: NodePrefabUsage) => void;
} | null>(null);

const References = styled.div`
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0 6px;
  color: var(--foreground-muted);
  font-size: var(--ui-font-size-sm);
  line-height: 1.5;
  cursor: default;
  summary {
    cursor: pointer;
  }
  summary:hover {
    color: var(--foreground);
  }
  .reference-links {
    max-height: 180px;
    overflow-y: auto;
    margin-top: 4px;
  }
  button {
    display: block;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  button:hover {
    background: var(--surface-row-hover-bg);
    color: var(--foreground);
  }
  button:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
`;

export function NodeLibraryReferences({ nodeId }: { nodeId: NodeId }) {
  const context = useContext(NodeLibraryReferencesContext);
  const usages = context?.usages.get(nodeId);
  if (!context || !usages) return null;

  return (
    <References
      className="node-library-references"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {usages.length === 0 ? (
        '0 references'
      ) : (
        <details>
          <summary>
            {usages.length} {usages.length === 1 ? 'reference' : 'references'}
          </summary>
          <div className="reference-links">
            {usages.map((usage) => (
              <button
                key={`${usage.graph.metadata?.id}:${usage.nodeId}`}
                type="button"
                title={`Open linked node ${usage.nodeId}`}
                onClick={() => context.onNavigate(usage)}
              >
                {usage.graph.metadata?.name || 'Untitled graph'} · {usage.nodeId}
              </button>
            ))}
          </div>
        </details>
      )}
    </References>
  );
}
