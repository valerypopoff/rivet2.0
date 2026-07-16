import clsx from 'clsx';
import PlusIcon from 'majesticons/line/plus-line.svg?react';
import type { FC, SVGProps } from 'react';
import type { UiGraph, UiGraphId } from '@valerypopoff/rivet2-core';

export const UiGraphResourceSection: FC<{
  onCreate(): void;
  onOpen(uiGraphId: UiGraphId): void;
  selectedUiGraphId?: UiGraphId;
  referencingSelectedUiGraphIds: ReadonlySet<UiGraphId>;
  uiGraphs: readonly UiGraph[];
}> = ({ onCreate, onOpen, referencingSelectedUiGraphIds, selectedUiGraphId, uiGraphs }) => (
  <>
    <div className="graph-list-heading">Web Apps</div>
    <div className="ui-graph-list">
      {uiGraphs.map((uiGraph) => (
        <button
          key={uiGraph.id}
          type="button"
          className={clsx('ui-graph-entry', { selected: selectedUiGraphId === uiGraph.id })}
          data-contextmenutype="ui-graph-item"
          data-uigraphid={uiGraph.id}
          onClick={() => onOpen(uiGraph.id)}
        >
          {referencingSelectedUiGraphIds.has(uiGraph.id) && <span className="graph-reference-dot" aria-hidden="true" />}
          <span className="project-tree-panel-icon project-tree-panel-icon-web-app">
            <WebAppIcon />
          </span>
          <span className="ui-graph-entry-name">{uiGraph.name}</span>
        </button>
      ))}
      <button type="button" className="ui-graph-create" onClick={onCreate}>
        <PlusIcon aria-hidden="true" className="project-tree-panel-icon" />
        <span>New web app</span>
      </button>
    </div>
  </>
);

const WebAppIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" {...props}>
    <rect x="2.5" y="3" width="11" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.45" />
    <path d="M2.9 6h10.2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45" />
  </svg>
);
