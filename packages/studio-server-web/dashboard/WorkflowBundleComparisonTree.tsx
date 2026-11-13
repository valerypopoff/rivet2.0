import { useState } from 'react';
import type {
  BundleComparisonCatalog,
  BundleComparisonPair,
} from '../../studio-server-shared/workflow-bundle-comparison-types';
import { bundleComparisonPairKey } from '../../studio-server-shared/workflow-bundle-comparison-types';
import { displayBundleMergePath } from './bundleMerge';
import './WorkflowBundleComparison.css';

export function WorkflowBundleComparisonTree({
  older,
  newer,
  pairs,
  selected,
  pending,
  errors,
  dirtyProjects,
  onSelect,
}: {
  older: BundleComparisonCatalog;
  newer: BundleComparisonCatalog;
  pairs: BundleComparisonPair[];
  selected: string | null;
  pending: string | null;
  errors: Record<string, string>;
  dirtyProjects: ReadonlySet<string>;
  onSelect(pair: BundleComparisonPair): void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const selectedPair = pairs.find((pair) => bundleComparisonPairKey(pair) === selected);
  const render = (catalog: BundleComparisonCatalog, role: 'Older' | 'Newer') => {
    const memberKey = role === 'Older' ? 'olderId' : 'newerId';
    const selectedProject = catalog.projects.find((p) => p.projectId === selectedPair?.[memberKey]);
    const folder = (path: string, root = false): React.ReactNode => {
      const key = `${catalog.bundleId}:${path}`;
      const prefix = path ? path + '/' : '';
      const containsSelection = closed[key] && selectedProject?.relativePath.startsWith(prefix);
      const children = new Set(
        catalog.folders
          .filter((p) => p.startsWith(prefix) && p !== path)
          .map((p) => p.slice(prefix.length).split('/')[0]!),
      );
      for (const p of catalog.projects)
        if (p.relativePath.startsWith(prefix) && p.relativePath.slice(prefix.length).includes('/'))
          children.add(p.relativePath.slice(prefix.length).split('/')[0]!);
      const projects = catalog.projects.filter(
        (p) => p.relativePath.startsWith(prefix) && !p.relativePath.slice(prefix.length).includes('/'),
      );
      return (
        <details
          className="comparison-folder"
          key={key}
          open={!closed[key]}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setClosed((prev) => (prev[key] === !open ? prev : { ...prev, [key]: !open }));
          }}
        >
          <summary className={containsSelection ? 'contains-selection' : undefined}>
            {root ? `${catalog.name} · ${role}` : path.split('/').at(-1)}
            {containsSelection ? <span className="bundle-comparison-sr-only"> · Contains selected project</span> : null}
          </summary>
          {[...children].sort().map((name) => folder(prefix + name))}
          {projects.map((p) => {
            const pair = pairs.find((pair) => pair[memberKey] === p.projectId)!;
            const pairKey = bundleComparisonPairKey(pair);
            const status =
              pending === pairKey
                ? 'Loading…'
                : errors[pairKey]
                  ? 'Unavailable'
                  : pair.olderId && pair.newerId
                    ? null
                    : role === 'Older'
                      ? 'Only in older'
                      : 'Only in newer';
            return (
              <button
                type="button"
                key={p.projectId}
                className={`project-row comparison-project-row${selected === pairKey ? ' active' : ''}`}
                data-comparison-role={role.toLowerCase()}
                aria-label={`Compare ${role} project ${p.name}${catalog.projects.filter((member) => member.name === p.name).length > 1 ? ` (${displayBundleMergePath(p.relativePath)})` : ''}`}
                aria-current={selected === pairKey ? 'true' : undefined}
                onClick={() => onSelect(pair)}
                title={errors[pairKey] || displayBundleMergePath(p.relativePath)}
              >
                <span className="comparison-project-name">
                  {p.name}
                  {dirtyProjects.has(p.projectId) ? (
                    <small> · {role === 'Newer' ? 'Unsaved' : 'Unsaved edits excluded'}</small>
                  ) : null}
                </span>
                {status ? <small className="comparison-project-status">{status}</small> : null}
              </button>
            );
          })}
          {root && !catalog.projects.length ? <p className="state">No projects</p> : null}
        </details>
      );
    };
    return folder('', true);
  };
  return (
    <div className="bundle-comparison-tree" aria-label="Compared bundles">
      {render(older, 'Older')}
      {render(newer, 'Newer')}
    </div>
  );
}
