import TextField from '@atlaskit/textfield';

import { ModeButton, ModeGroup, SettingsActions } from '../SettingsControls';
import type { DeploymentStorageSettingsForm } from '../model';
import type { useDeploymentStorageForm } from '../useDeploymentStorageForm';

export function StorageSettingsTab({ storage }: { storage: ReturnType<typeof useDeploymentStorageForm> }) {
  const form = storage.form;
  const update = <K extends keyof DeploymentStorageSettingsForm>(key: K, value: DeploymentStorageSettingsForm[K]) => {
    storage.setForm((current) => ({ ...current, [key]: value }));
    storage.clearFeedback();
  };

  return (
    <div className="project-settings-tab-panel app-settings-storage-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Project artifact storage">
        <div className="app-settings-field-grid" aria-busy={storage.controlsDisabled}>
          <div className="app-settings-field">
            <span className="app-settings-field-label">Project artifact storage</span>
            <ModeGroup label="Storage backend" wide>
              <ModeButton active={form.storageMode === 'filesystem'} disabled={storage.controlsDisabled} onClick={() => update('storageMode', 'filesystem')}>Local folders</ModeButton>
              <ModeButton active={form.storageMode === 'managed'} disabled={storage.controlsDisabled} onClick={() => update('storageMode', 'managed')}>Object storage</ModeButton>
            </ModeGroup>
            <span className="app-settings-field-help">
              {form.storageMode === 'filesystem'
                ? 'Saved projects, recordings, published snapshots, and runtime libraries use the mounted local folders.'
                : 'Saved projects, recordings, published snapshots, and runtime-library artifacts use S3-compatible object storage. Metadata is controlled by the database section below.'}
            </span>
          </div>

          {form.storageMode === 'filesystem' ? (
            <label className="app-settings-field">
              <span className="app-settings-field-label">Host artifacts folder</span>
              <TextField aria-label="Host artifacts folder" value={form.artifactsHostPath} isReadOnly placeholder="../" />
              <span className="app-settings-field-help">
                This is set before startup by the Docker/Kubernetes launcher, for example with RIVET_ARTIFACTS_HOST_PATH.
                The running app shows it for reference only because changing it here cannot remount host folders.
              </span>
            </label>
          ) : (
            <>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Object storage URL</span>
                <TextField aria-label="Object storage URL" value={form.storageUrl} isDisabled={storage.controlsDisabled} placeholder="https://bucket.region.example.com" onChange={(event) => update('storageUrl', event.currentTarget.value)} />
                <span className="app-settings-field-help">Use an S3-compatible bucket URL. For local MinIO rehearsals, enter the MinIO URL and credentials from the optional Compose service.</span>
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Object storage access key ID</span>
                <TextField aria-label="Object storage access key ID" value={form.storageAccessKeyId} isDisabled={storage.controlsDisabled} placeholder="access-key-id" onChange={(event) => update('storageAccessKeyId', event.currentTarget.value)} />
              </label>
              <label className="app-settings-field">
                <span className="app-settings-field-label">Object storage secret access key</span>
                <TextField aria-label="Object storage secret access key" type="password" value={form.storageAccessKey} isDisabled={storage.controlsDisabled} placeholder={form.storageAccessKeyConfigured ? 'Already saved; leave blank to keep it' : 'secret-access-key'} onChange={(event) => update('storageAccessKey', event.currentTarget.value)} />
                <span className="app-settings-field-help">
                  {form.storageAccessKeyConfigured
                    ? 'A secret access key is saved. Enter a new value only when rotating it.'
                    : 'Required before managed object storage can be enabled.'}
                </span>
              </label>
            </>
          )}
        </div>
      </section>

      <section className="app-settings-section" aria-label="Metadata database">
        <div className="app-settings-field-grid" aria-busy={storage.controlsDisabled}>
          <div className="app-settings-field">
            <span className="app-settings-field-label">Metadata database</span>
            <ModeGroup label="Database backend" wide>
              <ModeButton active={form.databaseMode === 'local-docker'} disabled={storage.controlsDisabled} onClick={() => {
                storage.setForm((current) => ({ ...current, databaseMode: 'local-docker', databaseSslMode: 'disable' }));
                storage.clearFeedback();
              }}>Local Docker Postgres</ModeButton>
              <ModeButton active={form.databaseMode === 'managed'} disabled={storage.controlsDisabled} onClick={() => {
                storage.setForm((current) => ({ ...current, databaseMode: 'managed', databaseSslMode: 'require' }));
                storage.clearFeedback();
              }}>Managed Postgres</ModeButton>
            </ModeGroup>
            <span className="app-settings-field-help">
              {form.databaseMode === 'local-docker'
                ? 'Use the optional Compose Postgres service for local managed-storage rehearsals. It must already be running before object storage mode can apply.'
                : 'Use an external PostgreSQL cluster for managed metadata. These fields can be prepared before switching project artifact storage to object storage.'}
            </span>
          </div>

          {form.databaseMode === 'managed' ? (
            <>
              <label className="app-settings-field">
                <span className="app-settings-field-label">PostgreSQL connection string</span>
                <TextField aria-label="PostgreSQL connection string" type="password" value={form.databaseConnectionString} isDisabled={storage.controlsDisabled} placeholder={form.databaseConnectionStringConfigured ? 'Already saved; leave blank to keep it' : 'postgresql://user:password@host:5432/database'} onChange={(event) => update('databaseConnectionString', event.currentTarget.value)} />
                <span className="app-settings-field-help">
                  {form.databaseConnectionStringConfigured
                    ? 'A connection string is saved. Enter a new value only when rotating it.'
                    : 'Required before object storage mode can use a managed PostgreSQL cluster.'}
                </span>
              </label>
              <div className="app-settings-field">
                <span className="app-settings-field-label">PostgreSQL SSL</span>
                <ModeGroup label="PostgreSQL SSL mode">
                  <ModeButton active={form.databaseSslMode === 'require'} disabled={storage.controlsDisabled} onClick={() => update('databaseSslMode', 'require')}>Require</ModeButton>
                  <ModeButton active={form.databaseSslMode === 'verify-full'} disabled={storage.controlsDisabled} onClick={() => update('databaseSslMode', 'verify-full')}>Verify full</ModeButton>
                  <ModeButton active={form.databaseSslMode === 'disable'} disabled={storage.controlsDisabled} onClick={() => update('databaseSslMode', 'disable')}>Disable</ModeButton>
                </ModeGroup>
              </div>
            </>
          ) : null}
        </div>
      </section>

      <SettingsActions
        changed={storage.changed}
        disabled={storage.controlsDisabled}
        error={storage.error}
        loading={storage.saving}
        onRevert={storage.revert}
        onSave={storage.save}
        saved={storage.saved}
        savedMessage="Saved. Restart Docker services or roll out Kubernetes pods to apply storage changes."
      />
    </div>
  );
}
