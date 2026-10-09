import { useId, useState } from 'react';
import { LoadingButton } from '@atlaskit/button';
import Select from '@atlaskit/select';
import type {
  LocalUpgradeDuplicateRepairAnalysis,
  LocalUpgradeDuplicateRepairChoices,
  LocalUpgradeDuplicateRepairStatus,
} from '../../../../studio-server-shared/local-upgrade-types';
import { BooleanSetting } from '../SettingsControls';

export function DuplicateProjectRepairPanel({
  analysis,
  repair,
  disabled,
  running,
  onInspect,
  onRepair,
  onRecover,
  downloadUrl,
}: {
  analysis?: LocalUpgradeDuplicateRepairAnalysis;
  repair?: LocalUpgradeDuplicateRepairStatus | null;
  disabled: boolean;
  running: boolean;
  onInspect(): void;
  onRepair(choices: LocalUpgradeDuplicateRepairChoices): void;
  onRecover(): void;
  downloadUrl?: string;
}) {
  const prefix = useId();
  const [choices, setChoices] = useState(
    () =>
      analysis?.groups.map((group) => ({
        projectId: group.projectId,
        keeperPath: group.projects.find((project) => project.published)?.path ?? group.projects[0]?.path ?? '',
        historyOwners: Object.fromEntries(group.history.map((entry) => [entry.id, entry.suggestedOwner ?? ''])),
      })) ?? [],
  );
  const [confirmed, setConfirmed] = useState(false);
  const valid =
    !!analysis?.groups.length &&
    choices.length === analysis.groups.length &&
    analysis.groups.every((group, index) => {
      const choice = choices[index];
      return (
        choice &&
        group.projects.some((project) => project.path === choice.keeperPath) &&
        group.projects.every((project) => !project.published || project.path === choice.keeperPath) &&
        group.history.every(
          (entry) =>
            group.projects.some((project) => project.path === choice.historyOwners[entry.id]) &&
            (!entry.activeOwner || entry.activeOwner === choice.historyOwners[entry.id]),
        )
      );
    });
  return (
    <section className="app-settings-section" aria-label="Repair conflicting project IDs">
      <h4 className="app-settings-section-title">Repair conflicting project IDs</h4>
      <p className="app-settings-field-help">
        Keep every project. Choose which file keeps the original ID; the others receive new IDs. Review publication
        ownership before confirming. No graphs, datasets or recordings are deleted.
      </p>
      {repair?.phase === 'applying' ? (
        <>
          <p role="alert" className="app-settings-inline-note app-settings-field-help">
            A recoverable repair is unfinished. Writes remain paused. Copying and resuming legacy are blocked until the
            saved repair is completed.
          </p>
          <LoadingButton
            className="local-upgrade-action button-size-l"
            appearance="primary"
            isDisabled={disabled}
            isLoading={running}
            aria-busy={running}
            onClick={onRecover}
          >
            Finish interrupted project-ID repair
          </LoadingButton>
        </>
      ) : (
        <>
          <LoadingButton
            className="local-upgrade-action button-size-l"
            isDisabled={disabled}
            isLoading={running}
            aria-busy={running}
            onClick={onInspect}
          >
            Inspect conflicting IDs
          </LoadingButton>
          {analysis?.groups.length === 0 && (
            <p role="status" className="app-settings-field-help">
              No duplicate project IDs found. Continue with source inspection and a new verified migration backup.
            </p>
          )}
          {analysis?.warnings.map((warning) => (
            <p key={warning} className="app-settings-field-help app-settings-inline-note">
              {warning}
            </p>
          ))}
          {analysis?.groups.map((group, index) => {
            const choice = choices[index];
            if (!choice) return null;
            const options = group.projects.map((project) => ({
              value: project.path,
              label: `${project.path}${project.published ? ' (published)' : ''}`,
            }));
            const update = (next: typeof choice) => {
              setConfirmed(false);
              setChoices((current) => current.map((value, position) => (position === index ? next : value)));
            };
            return (
              <fieldset key={group.projectId} className="local-upgrade-backup-form" disabled={disabled}>
                <legend className="app-settings-field-label">Conflicting ID: {group.projectId}</legend>
                <label htmlFor={`${prefix}-keeper-${index}`} className="app-settings-field-label">
                  Project keeping the original ID
                </label>
                <Select
                  inputId={`${prefix}-keeper-${index}`}
                  classNamePrefix="local-repair-select"
                  options={options}
                  value={options.find((option) => option.value === choice.keeperPath)}
                  isDisabled={disabled}
                  onChange={(option) => {
                    if (option) update({ ...choice, keeperPath: option.value });
                  }}
                />
                <p className="app-settings-field-help">
                  Other files receive new IDs:{' '}
                  {group.projects
                    .filter((project) => project.path !== choice.keeperPath)
                    .map((project) => project.path)
                    .join('; ')}
                  .
                </p>
                {group.projects.filter((project) => project.published).length > 1 && (
                  <p role="alert" className="app-settings-field-help app-settings-inline-note">
                    Multiple conflicting projects are published. Unpublish the endpoints and web apps on files receiving
                    new IDs before repair.
                  </p>
                )}
                <p className="app-settings-field-help">
                  {group.recordings} recordings and {group.operationalRows} ID-keyed operational rows remain with the
                  original ID. Existing references also remain with it
                  {group.references.length ? `: ${group.references.join('; ')}` : ' (none discovered)'}.
                </p>
                {group.history.map((entry, position) => (
                  <div key={entry.id} className="local-upgrade-repair-history">
                    <label htmlFor={`${prefix}-history-${index}-${position}`} className="app-settings-field-label">
                      Published version {entry.id}
                    </label>
                    <p className="app-settings-field-help">
                      Saved owner path: {entry.originalPath}.{' '}
                      {entry.activeOwner
                        ? 'Ownership is fixed by an active publication.'
                        : 'Suggested ownership is not proof; confirm the correct file.'}
                    </p>
                    <Select
                      inputId={`${prefix}-history-${index}-${position}`}
                      classNamePrefix="local-repair-select"
                      options={options}
                      value={options.find((option) => option.value === choice.historyOwners[entry.id]) ?? null}
                      placeholder="Choose the owner"
                      isDisabled={disabled || !!entry.activeOwner}
                      onChange={(option) => {
                        if (option)
                          update({ ...choice, historyOwners: { ...choice.historyOwners, [entry.id]: option.value } });
                      }}
                    />
                  </div>
                ))}
              </fieldset>
            );
          })}
          {!!analysis?.groups.length && (
            <>
              <BooleanSetting
                checked={confirmed}
                disabled={disabled}
                label="I confirm publication ownership and that existing references, recordings and ID-keyed operational history should remain with the project keeping the original ID. Pause writes, verify a repair backup and preserve every project."
                onChange={setConfirmed}
              />
              <LoadingButton
                appearance="primary"
                className="local-upgrade-action button-size-l"
                isDisabled={disabled || !valid || !confirmed}
                isLoading={running}
                aria-busy={running}
                onClick={() => {
                  if (analysis) onRepair({ token: analysis.token, groups: choices, retainReferences: true });
                }}
              >
                Pause writes and repair project IDs
              </LoadingButton>
              <p className="app-settings-field-help">
                The server restores and verifies a backup of changed documents before replacing them. Writes stay paused
                afterward; create and download a fresh full migration backup before copying.
              </p>
            </>
          )}
        </>
      )}
      {repair?.phase === 'complete' && (
        <>
          <p role="status" className="app-settings-field-help">
            Project-ID repair completed; {repair.changedFiles} documents updated. A fresh full migration backup is
            required.
          </p>
          <ul className="app-settings-field-help">
            {repair.assignments.map((entry) => (
              <li key={entry.path}>
                {entry.path}: {entry.newId}
              </li>
            ))}
          </ul>
        </>
      )}
      {downloadUrl && (
        <>
          <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
            Download verified repair backup
          </a>
          <p className="app-settings-field-help">
            This archive contains private project data. Store it securely outside the VM. It covers repaired documents
            only, not a full installation backup.
          </p>
        </>
      )}
    </section>
  );
}
