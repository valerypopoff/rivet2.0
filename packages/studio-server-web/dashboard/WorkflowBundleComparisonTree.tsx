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
  changedProjects,
  changeError,
  onSelect,
}: {
  older: BundleComparisonCatalog;
  newer: BundleComparisonCatalog;
  pairs: BundleComparisonPair[];
  selected: string | null;
  pending: string | null;
  errors: Record<string, string>;
  dirtyProjects: ReadonlySet<string>;
  changedProjects: ReadonlySet<string> | null;
  changeError: string;
  onSelect(pair: BundleComparisonPair): void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const render = (catalog: BundleComparisonCatalog, role: 'Older' | 'Newer') => {
    const memberKey = role === 'Older' ? 'olderId' : 'newerId';
    const members = catalog.projects.map((project) => ({
      project,
      pair: pairs.find((pair) => pair[memberKey] === project.projectId)!,
      removed: false,
    }));
    if (role === 'Newer')
      for (const pair of pairs)
        if (pair.olderId && !pair.newerId) {
          const project = older.projects.find((p) => p.projectId === pair.olderId);
          if (project) members.push({ project, pair, removed: true });
        }
    const selectedProject = members.find((member) => bundleComparisonPairKey(member.pair) === selected)?.project;
    const folder = (path: string, root = false): React.ReactNode => {
      const key = `${catalog.bundleId}:${path}`;
      const prefix = path ? path + '/' : '';
      const containsSelection = closed[key] && selectedProject?.relativePath.startsWith(prefix);
      const children = new Set(
        catalog.folders
          .filter((p) => p.startsWith(prefix) && p !== path)
          .map((p) => p.slice(prefix.length).split('/')[0]!),
      );
      for (const { project: p } of members)
        if (p.relativePath.startsWith(prefix) && p.relativePath.slice(prefix.length).includes('/'))
          children.add(p.relativePath.slice(prefix.length).split('/')[0]!);
      const projects = members.filter(
        ({ project: p }) => p.relativePath.startsWith(prefix) && !p.relativePath.slice(prefix.length).includes('/'),
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
          <summary
            title={root ? catalog.relativePath : path}
            className={containsSelection ? 'contains-selection' : undefined}
          >
            {root ? `${role} · ${catalog.name}` : path.split('/').at(-1)}
            {containsSelection ? <span className="bundle-comparison-sr-only"> · Contains selected project</span> : null}
          </summary>
          {[...children].sort().map((name) => folder(prefix + name))}
          {projects.map(({ project: p, pair, removed }) => {
            const path = displayBundleMergePath(p.relativePath);
            const pairKey = bundleComparisonPairKey(pair);
            const changeStatus =
              role === 'Older'
                ? null
                : removed
                  ? 'Removed'
                  : !pair.olderId
                    ? 'Added'
                    : changedProjects?.has(p.projectId)
                      ? 'Changed'
                      : changeError
                        ? 'Check failed'
                        : changedProjects === null
                          ? 'Checking…'
                          : null;
            const status = pending === pairKey ? 'Loading…' : errors[pairKey] ? 'Unavailable' : changeStatus;
            return (
              <button
                type="button"
                key={p.projectId}
                className={`project-row comparison-project-row${selected === pairKey ? ' active' : ''}`}
                data-comparison-role={role.toLowerCase()}
                aria-label={`Compare ${role} project ${p.name}${members.filter(({ project }) => project.name === p.name).length > 1 ? ` (${displayBundleMergePath(p.relativePath)})` : ''}`}
                aria-current={selected === pairKey ? 'true' : undefined}
                onClick={() => onSelect(pair)}
                title={
                  errors[pairKey] ||
                  (changeError && pair.newerId && pair.olderId
                    ? changeError
                    : path === p.name
                      ? p.name
                      : `${p.name}\n${path}`)
                }
              >
                <span className="comparison-project-name">
                  {p.name}
                  {!removed && dirtyProjects.has(p.projectId) ? (
                    <small> · {role === 'Newer' ? 'Unsaved' : 'Unsaved edits excluded'}</small>
                  ) : null}
                </span>
                {status ? (
                  <small className="comparison-project-status" data-change={status.toLowerCase()}>
                    {status}
                  </small>
                ) : null}
              </button>
            );
          })}
          {root && !members.length ? <p className="state">No projects</p> : null}
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
