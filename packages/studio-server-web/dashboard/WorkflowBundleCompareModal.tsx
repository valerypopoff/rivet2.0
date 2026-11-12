import { useEffect, useMemo, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import Select from '@atlaskit/select';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import type { WorkflowFolderItem } from './types';
import { readBundleComparison } from './bundleComparisonApi';
import {
  buildBundleComparisonPairs,
  suggestBundleComparison,
  type BundleComparisonChoices,
  type BundleComparisonManifest,
  type BundleComparisonPair,
  type BundleComparisonProject,
} from '../../studio-server-shared/workflow-bundle-comparison-types';
import { displayBundleMergePath } from './bundleMerge';
import './WorkflowProjectBundleModal.css';
import './WorkflowBundleMergeModal.css';
import './WorkflowBundleComparison.css';

type Option = { label: string; value: string; isDisabled?: boolean };
export type BundleComparisonSetup = { manifest: BundleComparisonManifest; pairs: BundleComparisonPair[] };

function projectLabel(project: BundleComparisonProject) {
  const path = displayBundleMergePath(project.relativePath);
  return path === project.name ? project.name : `${project.name} — ${path}`;
}

export function WorkflowBundleCompareModal({
  bundles,
  newerBundleId,
  initial,
  editorReady,
  onClose,
  onApply,
}: {
  bundles: WorkflowFolderItem[];
  newerBundleId: string;
  initial?: BundleComparisonSetup;
  editorReady: boolean;
  onClose(): void;
  onApply(setup: BundleComparisonSetup): void;
}) {
  const [olderId, setOlderId] = useState(initial?.manifest.older.bundleId ?? '');
  const [newerId, setNewerId] = useState(initial?.manifest.newer.bundleId ?? newerBundleId);
  const [manifest, setManifest] = useState<BundleComparisonManifest | null>(initial?.manifest ?? null);
  const [choices, setChoices] = useState<BundleComparisonChoices>(() =>
    Object.fromEntries(initial?.pairs.filter((p) => p.olderId).map((p) => [p.olderId!, p.newerId]) ?? []),
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const menuOpen = useRef(false);
  const identity = `${olderId}:${newerId}`;
  const matchesSelection = manifest?.older.bundleId === olderId && manifest?.newer.bundleId === newerId;
  const drafts = useRef<Record<string, BundleComparisonChoices>>(initial ? { [identity]: choices } : {});
  useEffect(() => {
    if (!olderId || !newerId || olderId === newerId) {
      setManifest(null);
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError('');
    void readBundleComparison<BundleComparisonManifest>('manifest', { olderId, newerId }, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        const suggested = suggestBundleComparison(next);
        const draft = drafts.current[identity];
        if (draft) {
          const valid = new Set(next.newer.projects.map((p) => p.projectId));
          for (const project of next.older.projects) {
            const target = draft[project.projectId];
            if (target === null || (target !== undefined && valid.has(target))) suggested[project.projectId] = target;
          }
        }
        setManifest(next);
        setChoices(suggested);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setManifest(null);
          setError(failure instanceof Error ? failure.message : 'Could not read bundles.');
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [olderId, newerId, refresh, identity]);
  const options = bundles
    .filter((p) => p.bundleId)
    .map((p) => ({ value: p.bundleId!, label: p.name === p.relativePath ? p.name : `${p.name} — ${p.relativePath}` }));
  const suggestions = useMemo(() => (manifest ? suggestBundleComparison(manifest) : {}), [manifest]);
  let pairs: BundleComparisonPair[] = [];
  let validation = '';
  if (manifest) {
    try {
      pairs = buildBundleComparisonPairs(manifest, choices);
    } catch (failure) {
      validation = (failure as Error).message;
    }
  }
  const select = (
    id: string,
    opts: Option[],
    value: string | null | undefined,
    change: (value: string) => void,
    placeholder = 'Choose a bundle…',
  ) => (
    <Select<Option>
      inputId={id}
      options={opts}
      value={opts.find((p) => p.value === value) ?? null}
      placeholder={placeholder}
      menuPortalTarget={document.body}
      menuPosition="fixed"
      menuPlacement="auto"
      styles={{ menuPortal: (base) => ({ ...base, zIndex: 20000 }) }}
      onMenuOpen={() => {
        menuOpen.current = true;
      }}
      onMenuClose={() => {
        menuOpen.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen.current) event.stopPropagation();
      }}
      onChange={(option) => {
        if (option) change(option.value);
      }}
    />
  );
  const swap = () => {
    drafts.current[identity] = choices;
    if (manifest && !validation) {
      const next = { ...manifest, older: manifest.newer, newer: manifest.older };
      drafts.current[`${newerId}:${olderId}`] = Object.fromEntries(
        pairs.filter((p) => p.newerId).map((p) => [p.newerId!, p.olderId]),
      );
      setManifest(next);
    }
    setOlderId(newerId);
    setNewerId(olderId);
  };
  return (
    <ModalDialog
      testId="workflow-bundle-compare-modal"
      label="Compare bundles"
      width="large"
      onClose={() => {
        if (!menuOpen.current) onClose();
      }}
    >
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-title">Compare bundles</div>
            <button
              type="button"
              className="project-settings-close-button"
              aria-label="Close bundle comparison"
              onClick={onClose}
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-bundle-merge-content">
            <div className="bundle-comparison-pickers">
              <div className="project-settings-field">
                <label htmlFor="compare-older-bundle">Older bundle</label>
                {select(
                  'compare-older-bundle',
                  options.filter((p) => p.value !== newerId),
                  olderId,
                  setOlderId,
                )}
              </div>
              <Button onClick={swap} isDisabled={!olderId || !newerId || loading}>
                Swap
              </Button>
              <div className="project-settings-field">
                <label htmlFor="compare-newer-bundle">Newer bundle</label>
                {select(
                  'compare-newer-bundle',
                  options.filter((p) => p.value !== olderId),
                  newerId,
                  setNewerId,
                )}
              </div>
            </div>
            <p className="project-settings-help">
              Edit and save the Newer projects normally. Older uses saved versions; unsaved Older edits are excluded.
            </p>
            {loading ? <p role="status">Loading project matches…</p> : null}
            {error ? (
              <div className="workflow-project-bundle-error" role="alert">
                {error} <Button onClick={() => setRefresh((n) => n + 1)}>Try again</Button>
              </div>
            ) : null}
            {manifest && matchesSelection && !loading ? (
              <section className="workflow-project-bundle-card">
                <h3>Match projects</h3>
                <table
                  className="workflow-bundle-merge-table workflow-bundle-merge-choices"
                  aria-label="Match projects"
                >
                  <thead>
                    <tr>
                      <th scope="col">Project in {manifest.older.name}</th>
                      <th scope="col">Corresponding project in {manifest.newer.name}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.older.projects.map((project) => {
                      const opts = [
                        {
                          value: 'none',
                          label:
                            'No corresponding project' +
                            (suggestions[project.projectId] === null ? ' (Suggested)' : ''),
                        },
                        ...manifest.newer.projects.map((p) => ({
                          value: `project:${p.projectId}`,
                          label:
                            projectLabel(p) + (suggestions[project.projectId] === p.projectId ? ' (Suggested)' : ''),
                          isDisabled: Object.entries(choices).some(
                            ([id, target]) => id !== project.projectId && target === p.projectId,
                          ),
                        })),
                      ];
                      return (
                        <tr key={project.projectId}>
                          <td>
                            <span className="workflow-bundle-merge-mobile-column" aria-hidden="true">
                              Project in {manifest.older.name}
                            </span>
                            <strong>{project.name}</strong>
                            {displayBundleMergePath(project.relativePath) !== project.name ? (
                              <div className="project-settings-muted">
                                {displayBundleMergePath(project.relativePath)}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            <span className="workflow-bundle-merge-mobile-column" aria-hidden="true">
                              Corresponding project in {manifest.newer.name}
                            </span>
                            <label className="bundle-comparison-sr-only" htmlFor={`match-${project.projectId}`}>
                              Counterpart for {project.name}
                              {manifest.older.projects.filter((p) => p.name === project.name).length > 1
                                ? ` (${displayBundleMergePath(project.relativePath)})`
                                : ''}
                            </label>
                            {select(
                              `match-${project.projectId}`,
                              opts,
                              choices[project.projectId] === null
                                ? 'none'
                                : choices[project.projectId]
                                  ? `project:${choices[project.projectId]}`
                                  : undefined,
                              (value) =>
                                setChoices((current) => {
                                  const next = {
                                    ...current,
                                    [project.projectId]: value === 'none' ? null : value.slice('project:'.length),
                                  };
                                  drafts.current[identity] = next;
                                  return next;
                                }),
                              'Choose a counterpart…',
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!manifest.older.projects.length ? <p>No projects in the Older bundle.</p> : null}
                <div>
                  <strong>Only in {manifest.newer.name}</strong>
                  <ul>
                    {manifest.newer.projects
                      .filter((p) => !Object.values(choices).includes(p.projectId))
                      .map((p) => (
                        <li key={p.projectId}>{projectLabel(p)}</li>
                      ))}
                  </ul>
                  {manifest.newer.projects.every((p) => Object.values(choices).includes(p.projectId)) ? (
                    <p>None</p>
                  ) : null}
                </div>
                {validation ? <p className="project-settings-help">{validation}</p> : null}
              </section>
            ) : null}
          </div>
          <div className="workflow-project-bundle-footer">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              appearance="primary"
              className="button-size-l"
              isDisabled={!editorReady || !matchesSelection || !manifest || loading || !!validation}
              onClick={() => {
                if (editorReady && matchesSelection && manifest && !validation) onApply({ manifest, pairs });
              }}
            >
              Compare bundles
            </Button>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
