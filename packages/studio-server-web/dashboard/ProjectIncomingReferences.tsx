import Button from '@atlaskit/button';
import { useEffect, useState } from 'react';
import type { WorkflowProjectReferencesResponse } from '../../studio-server-shared/workflow-types';
import { fetchWorkflowProjectReferences } from './workflowApi';

type ReferenceSource = WorkflowProjectReferencesResponse['references'][number]['sources'][number];
const sourceLabel = (source: ReferenceSource) => {
  const origin =
    source.kind === 'saved-latest'
      ? 'Saved latest'
      : source.kind === 'published-endpoint'
        ? `Published endpoint: ${source.label}`
        : `Published web app: ${source.label}`;
  const versions = source.targetVersions
    .map((version) =>
      version === 'latest' ? 'Saved latest' : version === 'published' ? 'Published' : 'Project reference',
    )
    .join(', ');
  return `${origin} → ${versions}`;
};

/** Mounted only in Danger zone; leaving the tab cancels observation and server work. */
export function ProjectIncomingReferences({ relativePath, projectId }: { relativePath: string; projectId?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<WorkflowProjectReferencesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setResult(null);
    setError(null);
    void fetchWorkflowProjectReferences(relativePath, projectId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult(data);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Could not check project references.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [relativePath, projectId, attempt]);

  if (!loading && !error && result?.complete && !result.references.length) return null;
  return (
    <section
      className="project-settings-incoming-references"
      aria-label="Projects referencing this project"
      aria-busy={loading}
    >
      <h4>Projects referencing this project</h4>
      {loading ? (
        <p className="project-settings-help" role="status">
          Checking saved projects and active publications…
        </p>
      ) : null}
      {error ? (
        <p className="project-settings-help" role="alert">
          References could not be checked: {error}
        </p>
      ) : null}
      {result ? (
        <>
          {result.references.length ? (
            <>
              <p className="project-settings-help">Deleting this project can break these direct connections:</p>
              <ul className="project-settings-reference-list">
                {result.references.map((reference) => (
                  <li key={reference.relativePath}>
                    <strong>{reference.name}</strong>
                    <span className="project-settings-help project-settings-reference-path">
                      {reference.relativePath}
                    </span>
                    {reference.sources.map((source, index) => (
                      <span className="project-settings-help" key={index}>
                        {sourceLabel(source)}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {!result.complete ? (
            <p className="project-settings-help" role="alert">
              This check is incomplete. {result.checkedProjects} of {result.totalProjects} other projects checked.
              {result.changedDuringScan ? ' Projects changed during the check.' : ''}
              {result.unreadableProjects.length
                ? ` Could not read: ${result.unreadableProjects.map((project) => project.relativePath).join(', ')}.`
                : ''}{' '}
              Other connections may exist; refresh before deleting.
            </p>
          ) : null}
        </>
      ) : null}
      {!loading ? (
        <Button appearance="subtle" onClick={() => setAttempt((value) => value + 1)}>
          {error || !result?.complete ? 'Retry reference check' : 'Refresh references'}
        </Button>
      ) : null}
    </section>
  );
}
