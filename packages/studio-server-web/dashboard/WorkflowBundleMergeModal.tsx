import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import Button, { LoadingButton } from '@atlaskit/button';
import Checkbox from '@atlaskit/checkbox';
import Select from '@atlaskit/select';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import { toast } from 'react-toastify';
import type {
  BundleMergeAction,
  BundleMergeChoices,
  BundleMergeDependency,
  BundleMergePreview,
  BundleMergeProject,
  BundleMergeSite,
  BundleMergeSuggestion,
} from '../../studio-server-shared/workflow-bundle-types';
import type { WorkflowFolderItem } from './types';
import type { LibraryMutationCompletion } from './workflowNamespaceReconciliation';
import { previewWorkflowBundleMerge, mergeWorkflowBundle } from './workflowApi';
import { MutationOutcomeUnknownError } from './workflowNamespaceMutations';
import {
  applyBundleMergeSuggestions,
  describeBundleMergeSite,
  displayBundleMergePath,
  formatBundleMergeProject,
  savedBundleMergePath,
  suggestBundleMergeCounterpart,
} from './bundleMerge';
import './WorkflowProjectBundleModal.css';
import './WorkflowBundleMergeModal.css';

type Option = {
  label: string;
  value: string;
  isDisabled?: boolean;
  hint?: string;
  project?: { action: 'Replace' | 'Use existing'; name: string };
};
const graphKey = (id: string, graph: string) => JSON.stringify([id, graph]);
const countLabel = (count: number, label: string, plural = label + 's') => count + ' ' + (count === 1 ? label : plural);
const actionValue = (action?: BundleMergeAction) =>
  !action ? 'skip' : action.kind === 'add' ? 'add' : 'replace:' + action.targetProjectId;
const dependencyValue = (choice?: BundleMergeDependency) =>
  !choice ? '' : choice.kind === 'add' ? 'add' : 'existing:' + choice.targetProjectId;
const emptyChoices = (destinationBundleId = ''): BundleMergeChoices => ({
  destinationBundleId,
  actions: [],
  dependencies: [],
  graphs: [],
});

type MenuChange = (id: string, open: boolean) => void;
type ProjectColumns = { source: string; destination: string };

function ProjectChoicesTable({
  columns,
  label,
  children,
}: {
  columns: ProjectColumns;
  label: string;
  children: ReactNode;
}) {
  return (
    <table className="workflow-bundle-merge-table workflow-bundle-merge-choices" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{columns.source}</th>
          <th scope="col">{columns.destination}</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
function MergeSelect({
  onMenuChange,
  onMenuOpen,
  onMenuClose,
  ...props
}: ComponentProps<typeof Select<Option>> & {
  inputId: string;
  onMenuChange: MenuChange;
}) {
  const menuOpen = useRef(false);
  useEffect(() => () => onMenuChange(props.inputId, false), [props.inputId, onMenuChange]);
  return (
    <Select<Option>
      menuPortalTarget={document.body}
      menuPosition="fixed"
      menuPlacement="auto"
      styles={{ menuPortal: (base) => ({ ...base, zIndex: 20000 }) }}
      formatOptionLabel={(option, meta) => (
        <span className="workflow-bundle-merge-option">
          <span>
            {option.project ? (
              <>
                {option.project.action} <code>{option.project.name}</code>
              </>
            ) : (
              option.label
            )}
          </span>
          {meta.context === 'menu' && option.hint ? <small>{option.hint}</small> : null}
        </span>
      )}
      {...props}
      onMenuOpen={() => {
        menuOpen.current = true;
        onMenuChange(props.inputId, true);
        onMenuOpen?.();
      }}
      onMenuClose={() => {
        menuOpen.current = false;
        onMenuChange(props.inputId, false);
        onMenuClose?.();
      }}
      onKeyDown={(event) => {
        // Let Select close its menu without the same Escape dismissing the dialog.
        if (event.key === 'Escape' && menuOpen.current) event.stopPropagation();
        props.onKeyDown?.(event);
      }}
    />
  );
}

function ProjectChoiceRow({
  project,
  scope,
  value,
  options,
  disabled,
  onChange,
  path,
  onPathChange,
  children,
  onMenuChange,
  columns,
}: {
  project: BundleMergeProject;
  scope: 'action' | 'dependency';
  value: string;
  options: Option[];
  disabled: boolean;
  onChange(value: string): void;
  path?: string;
  onPathChange(value: string): void;
  children?: ReactNode;
  onMenuChange: MenuChange;
  columns: ProjectColumns;
}) {
  const id = 'merge-' + scope + '-' + project.projectId;
  return (
    <tr className="workflow-bundle-merge-row">
      <td>
        <label className="workflow-bundle-merge-project" htmlFor={id}>
          <span className="workflow-bundle-merge-mobile-column" aria-hidden="true">
            {columns.source}
          </span>
          <strong>{project.title}</strong>
          {displayBundleMergePath(project.relativePath) !== project.title ? (
            <small>{displayBundleMergePath(project.relativePath)}</small>
          ) : null}
        </label>
        {children ? <div className="workflow-bundle-merge-row-details">{children}</div> : null}
      </td>
      <td>
        <span className="workflow-bundle-merge-mobile-column" aria-hidden="true">
          {columns.destination}
        </span>
        <MergeSelect
          onMenuChange={onMenuChange}
          inputId={id}
          isDisabled={disabled}
          options={options}
          value={options.find((option) => option.value === value) ?? null}
          placeholder="Choose an action…"
          onChange={(option) => onChange(option?.value ?? '')}
        />
        {path !== undefined ? (
          <div className="project-settings-field workflow-bundle-merge-path">
            <label htmlFor={id + '-path'}>Project name</label>
            <input
              id={id + '-path'}
              className="project-settings-input"
              aria-label={(scope === 'action' ? 'Project name for ' : 'Referenced project name for ') + project.title}
              autoComplete="off"
              spellCheck={false}
              value={displayBundleMergePath(path)}
              disabled={disabled}
              onChange={(event) => onPathChange(savedBundleMergePath(event.target.value))}
            />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function WorkflowBundleMergeModal({
  source,
  bundles,
  initialDestinationBundleId,
  onClose,
  onStructuralMutation,
}: {
  source: WorkflowFolderItem;
  bundles: WorkflowFolderItem[];
  initialDestinationBundleId?: string;
  onClose(): void;
  onStructuralMutation: LibraryMutationCompletion;
}) {
  const [choices, setChoices] = useState<BundleMergeChoices>(() => emptyChoices(initialDestinationBundleId));
  const latest = useRef(choices);
  const [catalogs, setCatalogs] = useState<BundleMergePreview | null>(null);
  const [review, setReview] = useState<{ choices: BundleMergeChoices; value: BundleMergePreview } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [suggestions, setSuggestions] = useState<BundleMergeSuggestion[]>();
  const currentSuggestions = useRef<BundleMergeSuggestion[]>();
  const initializeChoices = useRef(true);
  const compareChanges = useRef(true);
  const [openSelect, setOpenSelect] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const pending = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController>();
  const errorDetails = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const trackSelect = useCallback<MenuChange>((id, open) => {
    if (mounted.current) setOpenSelect((current) => (open ? id : current === id ? null : current));
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  const change = (next: BundleMergeChoices) => {
    if (pending.current || unknown) return;
    latest.current = next;
    abort.current?.abort();
    setChoices(next);
    setReview(null);
    setAcknowledged([]);
    setError('');
  };
  useEffect(() => {
    setReview(null);
    if (!choices.destinationBundleId || unknown) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void previewWorkflowBundleMerge(source.bundleId!, choices, controller.signal, compareChanges.current)
        .then((value) => {
          if (controller.signal.aborted || latest.current !== choices || pending.current) return;
          if (value.suggestions) {
            currentSuggestions.current = value.suggestions;
            setSuggestions(value.suggestions);
          }
          const next = applyBundleMergeSuggestions(
            choices,
            value,
            currentSuggestions.current,
            initializeChoices.current,
          );
          initializeChoices.current = false;
          compareChanges.current = false;
          setCatalogs(value);
          if (next !== choices) {
            change(next);
            return;
          }
          setReview({ choices, value });
          setLoading(false);
        })
        .catch((failure) => {
          if (controller.signal.aborted || latest.current !== choices) return;
          setError(failure instanceof Error ? failure.message : 'Could not review the merge.');
          setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [choices, refresh, source.bundleId, unknown]);
  const preview = review?.choices === choices ? review.value : null;
  // Keep editable fields mounted while their next validation is pending.
  // Only preview, never this retained form metadata, authorizes a submission.
  const form = catalogs?.destination.bundleId === choices.destinationBundleId ? catalogs : null;
  const disabled = busy || unknown;
  const close = () => {
    if (!pending.current) onClose();
  };
  const submit = async () => {
    if (
      pending.current ||
      unknown ||
      loading ||
      error ||
      !preview?.fingerprint ||
      latest.current !== review?.choices ||
      preview.warnings.some((warning) => !acknowledged.includes(warning.id))
    )
      return;
    pending.current = true;
    abort.current?.abort();
    setBusy(true);
    setError('');
    try {
      await mergeWorkflowBundle(
        source.bundleId!,
        {
          choices,
          fingerprint: preview.fingerprint,
          acknowledgedWarnings: acknowledged,
        },
        preview.source.namespaceId,
        preview.destination.namespaceId,
      );
      onStructuralMutation(
        'Merge completed, but the project list could not refresh. Refresh the tree; do not merge again.',
        (tree) => {
          if (tree) toast.success('Project changes merged into ' + preview.destination.relativePath + '.');
        },
      );
      if (mounted.current) onClose();
    } catch (failure) {
      if (failure instanceof MutationOutcomeUnknownError) {
        onStructuralMutation(failure.message);
        if (mounted.current) setUnknown(true);
      }
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : 'Could not merge the bundle.');
        setReview(null);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const updateAction = (project: BundleMergeProject, value: string) => {
    const previous = choices.actions.find((action) => action.sourceProjectId === project.projectId);
    if ((value || 'skip') === actionValue(previous)) return;
    let action: BundleMergeAction | undefined;
    if (value === 'add')
      action = { sourceProjectId: project.projectId, kind: 'add', relativePath: project.relativePath };
    else if (value.startsWith('replace:'))
      action = {
        sourceProjectId: project.projectId,
        kind: 'replace',
        targetProjectId: value.slice(8),
      };
    change({
      ...choices,
      actions: [
        ...choices.actions.filter((choice) => choice.sourceProjectId !== project.projectId),
        ...(action ? [action] : []),
      ],
      graphs: choices.graphs.filter((graph) => graph.sourceProjectId !== project.projectId),
    });
  };
  const updateDependency = (project: BundleMergeProject, value: string) => {
    const previous = choices.dependencies.find((choice) => choice.sourceProjectId === project.projectId);
    if (value === dependencyValue(previous)) return;
    let dependency: BundleMergeDependency | undefined;
    if (value === 'add')
      dependency = { sourceProjectId: project.projectId, kind: 'add', relativePath: project.relativePath };
    else if (value.startsWith('existing:'))
      dependency = {
        sourceProjectId: project.projectId,
        kind: 'existing',
        targetProjectId: value.slice(9),
      };
    change({
      ...choices,
      dependencies: [
        ...choices.dependencies.filter((choice) => choice.sourceProjectId !== project.projectId),
        ...(dependency ? [dependency] : []),
      ],
      graphs: choices.graphs.filter((graph) => graph.sourceProjectId !== project.projectId),
    });
  };
  const candidates: Option[] = bundles
    .filter((bundle) => bundle.bundleId && bundle.bundleId !== source.bundleId && bundle.namespaceId)
    .map((bundle) => ({ value: bundle.bundleId!, label: bundle.name + ' — ' + bundle.relativePath }));
  const targets: Option[] = (form?.destination.projects ?? []).map((project) => ({
    value: project.projectId,
    label: formatBundleMergeProject(project),
  }));
  const columns = {
    source: `Source project in ${form?.source.name ?? source.name}`,
    destination: `Destination in ${form?.destination.name ?? ''}`,
  };
  const projects = (form?.source.projects ?? []).filter(
    (project) =>
      choices.actions.some((action) => action.sourceProjectId === project.projectId) ||
      !suggestions?.some(
        (suggestion) => suggestion.sourceProjectId === project.projectId && suggestion.state === 'unchanged',
      ),
  );
  const requiredProjects = choices.actions.length
    ? (form?.requiredProjects ?? []).filter(
        ({ project }) => !choices.actions.some((action) => action.sourceProjectId === project.projectId),
      )
    : [];
  const graphChoices = [...(form?.requiredGraphs ?? []), ...(form?.mappedGraphs ?? [])].filter(
    (graph) =>
      !choices.actions.some((action) => action.sourceProjectId === graph.sourceProjectId) &&
      choices.dependencies.some(
        (choice) =>
          choice.sourceProjectId === graph.sourceProjectId &&
          choice.kind === 'existing' &&
          choice.targetProjectId === graph.targetProjectId,
      ),
  );
  const allAcknowledged = !!preview && preview.warnings.every((warning) => acknowledged.includes(warning.id));
  const canMerge = !busy && !loading && !unknown && !error && !!preview?.fingerprint && allAcknowledged;
  const siteLabel = (site: BundleMergeSite) => describeBundleMergeSite(site, form);
  const keptCounterparts =
    preview?.requiredProjects.filter(({ project }) =>
      choices.dependencies.some((choice) => choice.sourceProjectId === project.projectId && choice.kind === 'existing'),
    ).length ?? 0;
  function readinessMessage() {
    if (busy) return 'Merging saved project changes…';
    if (unknown) return 'The outcome is unconfirmed. Refresh the project tree before starting another merge.';
    if (error) return 'Could not complete the action. View the error details.';
    if (loading) return 'Checking selected projects and required references…';
    if (!choices.destinationBundleId) return 'Choose a destination bundle to begin.';
    if (form && !form.source.projects.length) return 'The source bundle has no saved projects.';
    if (form && suggestions && !projects.length) return 'No saved project changes to merge.';
    if (!choices.actions.length) return 'Choose projects to replace or add.';
    if (!preview) return 'Refresh the review before merging.';
    if (preview.blockers.length)
      return countLabel(preview.blockers.length, 'issue') + ' must be resolved in the review.';
    if (preview.requiredGraphs.length)
      return 'Choose ' + countLabel(preview.requiredGraphs.length, 'graph match', 'graph matches') + ' to continue.';
    const missing = preview.requiredProjects.filter(
      ({ project }) =>
        !choices.dependencies.some((choice) => choice.sourceProjectId === project.projectId) &&
        !choices.actions.some((action) => action.sourceProjectId === project.projectId),
    ).length;
    if (missing) return 'Choose ' + countLabel(missing, 'project match', 'project matches') + ' to continue.';
    const warnings = preview.warnings.filter((warning) => !acknowledged.includes(warning.id)).length;
    if (warnings) return countLabel(warnings, 'warning') + ' to acknowledge in the review.';
    return preview.fingerprint ? 'Ready to merge selected projects.' : 'Refresh the review before merging.';
  }
  return (
    <ModalDialog
      label="Merge bundle"
      testId="workflow-bundle-merge-modal"
      width="large"
      onClose={close}
      shouldCloseOnEscapePress={!busy && openSelect === null}
      shouldCloseOnOverlayClick={!busy}
    >
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell workflow-bundle-merge-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-heading">
              <div className="project-settings-modal-title">Merge bundle</div>
              <small className="project-settings-muted">
                {form?.source.relativePath ?? source.relativePath} →{' '}
                {form?.destination.relativePath ??
                  bundles.find((bundle) => bundle.bundleId === choices.destinationBundleId)?.relativePath ??
                  'Choose a destination'}
              </small>
            </div>
            <button
              type="button"
              className="project-settings-close-button"
              aria-label="Close bundle merge"
              disabled={busy}
              onClick={close}
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-bundle-merge-content" ref={content}>
            <div className="project-settings-field">
              <label htmlFor="bundle-merge-destination">Destination bundle</label>
              <MergeSelect
                onMenuChange={trackSelect}
                autoFocus
                inputId="bundle-merge-destination"
                isDisabled={disabled}
                options={candidates}
                placeholder="Choose a bundle…"
                noOptionsMessage={() => 'No other bundles available'}
                value={candidates.find((option) => option.value === choices.destinationBundleId) ?? null}
                onChange={(option) => {
                  const destinationId = option?.value ?? '';
                  if (destinationId === latest.current.destinationBundleId) return;
                  initializeChoices.current = true;
                  compareChanges.current = true;
                  currentSuggestions.current = undefined;
                  setSuggestions(undefined);
                  setCatalogs(null);
                  change(emptyChoices(destinationId));
                }}
              />
              {!candidates.length ? (
                <p className="project-settings-help">Convert another folder to a bundle to create a destination.</p>
              ) : null}
            </div>
            {form && !form.destination.projects.length ? (
              <p className="project-settings-help">
                The destination is empty. Add the projects you want to copy into this bundle.
              </p>
            ) : null}
            {form && !projects.length ? (
              <p className="workflow-bundle-merge-empty" role="status">
                {!form.source.projects.length
                  ? 'This bundle has no saved projects to merge.'
                  : 'No saved project changes to merge. The projects already match the destination.'}
              </p>
            ) : form ? (
              <section className="workflow-project-bundle-card" aria-label="Project changes">
                <h3>Choose project changes</h3>
                <p className="project-settings-help">
                  {suggestions
                    ? 'Only changed and newly added projects are listed'
                    : 'Choose project changes manually. This server does not provide saved-content comparison.'}
                </p>
                <ProjectChoicesTable columns={columns} label="Project changes">
                  {projects.map((project) => {
                    const action = choices.actions.find((choice) => choice.sourceProjectId === project.projectId);
                    const suggestion = suggestions?.find(
                      (suggestion) => suggestion.sourceProjectId === project.projectId,
                    );
                    const suggested =
                      suggestion?.targetProjectId ??
                      (!suggestions ? suggestBundleMergeCounterpart(project, form.destination.projects) : null);
                    const options: Option[] = [
                      { value: 'skip', label: 'Skip' },
                      {
                        value: 'add',
                        label: 'Add as a new project',
                        hint: suggestion?.state === 'new' ? 'Suggested' : undefined,
                      },
                      ...targets
                        .map((target): Option => {
                          const used = choices.actions.some(
                            (choice) =>
                              choice.kind === 'replace' &&
                              choice.targetProjectId === target.value &&
                              choice.sourceProjectId !== project.projectId,
                          );
                          return {
                            value: 'replace:' + target.value,
                            label: 'Replace ' + target.label,
                            project: { action: 'Replace', name: target.label },
                            isDisabled: used,
                            hint: used ? 'Already chosen' : target.value === suggested ? 'Suggested' : undefined,
                          };
                        })
                        .sort((a, b) => Number(b.hint === 'Suggested') - Number(a.hint === 'Suggested')),
                    ];
                    const requiredAddition =
                      choices.actions.length > 0 &&
                      !action &&
                      form.actions.some(
                        (choice) => choice.sourceProjectId === project.projectId && choice.kind === 'add',
                      );
                    return (
                      <ProjectChoiceRow
                        onMenuChange={trackSelect}
                        key={project.projectId}
                        project={project}
                        columns={columns}
                        scope="action"
                        options={options}
                        value={actionValue(action)}
                        disabled={disabled}
                        onChange={(value) => updateAction(project, value)}
                        path={action?.kind === 'add' ? action.relativePath : undefined}
                        onPathChange={(value) =>
                          change({
                            ...choices,
                            actions: choices.actions.map((choice) =>
                              choice === action && choice.kind === 'add' ? { ...choice, relativePath: value } : choice,
                            ),
                          })
                        }
                      >
                        {suggestion?.state === 'ambiguous' ? (
                          <small>No unique match was found. Choose a replacement or add a new project.</small>
                        ) : null}
                        {requiredAddition ? <small>Will be added as a required reference below.</small> : null}
                      </ProjectChoiceRow>
                    );
                  })}
                </ProjectChoicesTable>
                {choices.actions.some((action) => action.kind === 'add') ? (
                  <p className="project-settings-help">
                    Choose a project name, with optional folders inside {form.destination.relativePath}.
                  </p>
                ) : null}
              </section>
            ) : null}
            {form && requiredProjects.length ? (
              <section
                className="workflow-project-bundle-card"
                aria-label="Required project references"
                aria-busy={loading}
              >
                <h3>Match referenced projects</h3>
                <p className="project-settings-help">
                  The projects above reference these other projects. Choose their counterparts in{' '}
                  {form.destination.name}.
                </p>
                <ProjectChoicesTable columns={columns} label="Referenced project matches">
                  {requiredProjects.map(({ project, sites }) => {
                    const dependency = choices.dependencies.find(
                      (choice) => choice.sourceProjectId === project.projectId,
                    );
                    const suggestion = suggestions?.find(
                      (suggestion) => suggestion.sourceProjectId === project.projectId,
                    );
                    const suggested =
                      suggestion?.targetProjectId ??
                      (!suggestions ? suggestBundleMergeCounterpart(project, form.destination.projects) : null);
                    return (
                      <ProjectChoiceRow
                        onMenuChange={trackSelect}
                        key={project.projectId}
                        project={project}
                        columns={columns}
                        scope="dependency"
                        disabled={disabled}
                        options={[
                          {
                            value: 'add',
                            label: 'Add as a new project',
                            hint: suggestion?.state === 'new' ? 'Suggested' : undefined,
                          },
                          ...targets.map(
                            (target): Option => ({
                              value: 'existing:' + target.value,
                              label: 'Use existing ' + target.label,
                              project: { action: 'Use existing', name: target.label },
                              hint: target.value === suggested ? 'Suggested' : undefined,
                            }),
                          ),
                        ]}
                        value={dependencyValue(dependency)}
                        onChange={(value) => updateDependency(project, value)}
                        path={dependency?.kind === 'add' ? dependency.relativePath : undefined}
                        onPathChange={(value) =>
                          change({
                            ...choices,
                            dependencies: choices.dependencies.map((choice) =>
                              choice === dependency && choice.kind === 'add'
                                ? { ...choice, relativePath: value }
                                : choice,
                            ),
                          })
                        }
                      >
                        <details>
                          <summary>Referenced in {countLabel(sites.length, 'place')}</summary>
                          <ul>
                            {sites.map((site, index) => (
                              <li key={index}>{siteLabel(site)}</li>
                            ))}
                          </ul>
                        </details>
                      </ProjectChoiceRow>
                    );
                  })}
                </ProjectChoicesTable>
              </section>
            ) : null}
            {graphChoices.length ? (
              <section className="workflow-project-bundle-card" aria-label="Graph correspondences" aria-busy={loading}>
                <h3>Match graphs</h3>
                {graphChoices.map((graph) => {
                  const key = graphKey(graph.sourceProjectId, graph.sourceGraphId);
                  const selected = choices.graphs.find(
                    (choice) => graphKey(choice.sourceProjectId, choice.sourceGraphId) === key,
                  );
                  const project = form!.source.projects.find((project) => project.projectId === graph.sourceProjectId);
                  const target = form!.destination.projects.find(
                    (project) => project.projectId === graph.targetProjectId,
                  );
                  const options = graph.options.map((option) => ({
                    value: option.id,
                    label:
                      option.name +
                      (graph.options.filter((other) => other.name === option.name).length > 1
                        ? ' (' + option.id + ')'
                        : ''),
                  }));
                  return (
                    <div className="workflow-bundle-merge-graph-row" key={key}>
                      <label className="workflow-bundle-merge-project" htmlFor={'merge-graph-' + key}>
                        <strong>
                          Graph match for {project?.title} / {graph.sourceGraphName}
                        </strong>
                        <small>
                          {displayBundleMergePath(project?.relativePath ?? '')} →{' '}
                          {displayBundleMergePath(target?.relativePath ?? '')}
                        </small>
                      </label>
                      <MergeSelect
                        onMenuChange={trackSelect}
                        inputId={'merge-graph-' + key}
                        isDisabled={disabled}
                        options={options}
                        placeholder="Choose a graph…"
                        value={options.find((option) => option.value === selected?.targetGraphId) ?? null}
                        onChange={(option) =>
                          option &&
                          change({
                            ...choices,
                            graphs: [
                              ...choices.graphs.filter(
                                (choice) => graphKey(choice.sourceProjectId, choice.sourceGraphId) !== key,
                              ),
                              {
                                sourceProjectId: graph.sourceProjectId,
                                sourceGraphId: graph.sourceGraphId,
                                targetGraphId: option.value,
                              },
                            ],
                          })
                        }
                      />
                      {graph.sites.length ? (
                        <details className="workflow-bundle-merge-row-details">
                          <summary>Referenced in {countLabel(graph.sites.length, 'place')}</summary>
                          <ul>
                            {graph.sites.map((site, index) => (
                              <li key={index}>{siteLabel(site)}</li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            ) : null}
            {form?.mappedGraphs === undefined
              ? choices.graphs.map((graph) => (
                  <p key={graphKey(graph.sourceProjectId, graph.sourceGraphId)}>
                    Graph mapping: {graph.sourceGraphId} → {graph.targetGraphId}{' '}
                    <Button
                      appearance="subtle"
                      isDisabled={disabled}
                      onClick={() =>
                        change({ ...choices, graphs: choices.graphs.filter((choice) => choice !== graph) })
                      }
                    >
                      Change graph
                    </Button>
                  </p>
                ))
              : null}
            {preview && choices.actions.length ? (
              <section className="workflow-project-bundle-card" aria-label="Merge review">
                <h3>Review changes</h3>
                <p>
                  {countLabel(preview.actions.filter((action) => action.kind === 'replace').length, 'replacement')};{' '}
                  {countLabel(preview.actions.filter((action) => action.kind === 'add').length, 'addition')};{' '}
                  {countLabel(keptCounterparts, 'kept counterpart')};{' '}
                  {countLabel(preview.rewrites, 'reference rewrite')}.
                </p>
                <div className="workflow-bundle-merge-table-wrap">
                  <table className="workflow-bundle-merge-table">
                    <caption className="workflow-bundle-merge-sr-only">Selected project changes</caption>
                    <thead>
                      <tr>
                        <th scope="col">Source project in {preview.source.name}</th>
                        <th scope="col">Destination in {preview.destination.name}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.actions.map((action) => (
                        <tr key={action.sourceProjectId}>
                          <td>
                            {displayBundleMergePath(
                              preview.source.projects.find((project) => project.projectId === action.sourceProjectId)
                                ?.relativePath ?? action.sourceProjectId,
                            )}
                          </td>
                          <td>
                            <strong>{action.kind === 'replace' ? 'Replace' : 'Add'}</strong>{' '}
                            {displayBundleMergePath(
                              action.kind === 'replace'
                                ? preview.destination.projects.find(
                                    (project) => project.projectId === action.targetProjectId,
                                  )?.relativePath ?? action.targetProjectId
                                : action.relativePath,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="project-settings-help">
                  Replacements overwrite saved project content. Destination IDs, names, locations and saved history are
                  kept.
                </p>
                <p className="project-settings-help">
                  Internal references use Saved latest
                  {preview.versionChanges
                    ? '; ' + countLabel(preview.versionChanges, 'Published binding') + ' will change'
                    : ''}
                  . Publications stay unchanged; published apps that call Saved latest can observe the new drafts.
                </p>
                {preview.blockers.map((issue) => (
                  <p className="workflow-bundle-merge-issue" role="alert" key={issue.id}>
                    {issue.site ? siteLabel(issue.site) + ': ' : ''}
                    {issue.message}
                  </p>
                ))}
                {preview.warnings.map((warning) => (
                  <div className="workflow-bundle-merge-warning" key={warning.id}>
                    <Checkbox
                      isDisabled={disabled}
                      isChecked={acknowledged.includes(warning.id)}
                      label={
                        <span>
                          {warning.site ? siteLabel(warning.site) + ': ' : ''}
                          {warning.message}
                        </span>
                      }
                      onChange={(event) =>
                        setAcknowledged(
                          event.currentTarget.checked
                            ? [...acknowledged, warning.id]
                            : acknowledged.filter((id) => id !== warning.id),
                        )
                      }
                    />
                  </div>
                ))}
              </section>
            ) : null}
            {error ? (
              <div className="workflow-project-bundle-error" role="alert" ref={errorDetails} tabIndex={-1}>
                {error}
              </div>
            ) : null}
          </div>
          <div className="workflow-project-bundle-footer workflow-bundle-merge-footer">
            <div className="workflow-bundle-merge-footer-status">
              <p className={error || unknown ? 'workflow-bundle-merge-issue' : 'project-settings-muted'} role="status">
                {readinessMessage()}
              </p>
              {error && !busy ? (
                <Button
                  appearance="link"
                  onClick={() => {
                    const scroll = content.current,
                      target = errorDetails.current;
                    if (!scroll || !target) return;
                    const top =
                      scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
                    scroll.scrollTo({ top });
                    target.focus({ preventScroll: true });
                  }}
                >
                  View error
                </Button>
              ) : null}
            </div>
            <div className="workflow-bundle-merge-footer-actions">
              <Button className="workflow-project-bundle-action button-size-l" isDisabled={busy} onClick={close}>
                {unknown ? 'Close' : 'Cancel'}
              </Button>
              <Button
                className="workflow-project-bundle-action button-size-l"
                isDisabled={disabled || loading || !choices.destinationBundleId}
                onClick={() => {
                  abort.current?.abort();
                  compareChanges.current = true;
                  setReview(null);
                  setAcknowledged([]);
                  setRefresh((value) => value + 1);
                }}
              >
                Refresh review
              </Button>
              <LoadingButton
                appearance="primary"
                className="workflow-project-bundle-action workflow-project-bundle-primary button-size-l"
                isLoading={busy}
                isDisabled={!canMerge}
                onClick={() => void submit()}
              >
                Merge projects
              </LoadingButton>
            </div>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
