import TextField from '@atlaskit/textfield';
import { LegacyRestorePanel } from './LegacyRestorePanel';
import type { useDeploymentStorageForm } from '../useDeploymentStorageForm';

function StorageField({ label, value, hidden = false }: { label: string; value: string; hidden?: boolean }) {
  return (
    <label className="app-settings-field">
      <span className="app-settings-field-label">{label}</span>
      <TextField aria-label={label} value={hidden ? '' : value} isReadOnly placeholder={hidden ? value : undefined} />
    </label>
  );
}

export function StorageSettingsTab({ storage }: { storage: ReturnType<typeof useDeploymentStorageForm> }) {
  const form = storage.form;
  return (
    <div className="project-settings-tab-panel app-settings-storage-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Storage configuration">
        <p>
          <strong>S3-compatible object storage + PostgreSQL</strong>
        </p>
        <p className="app-settings-field-help">
          Projects, recordings, published snapshots and runtime-library artifacts use S3-compatible storage. PostgreSQL
          stores metadata and server settings. Both services can be local or external. Connections and credentials are
          set before startup and are read-only here.
        </p>
        {storage.error ? <p role="alert">{storage.error}</p> : null}
        {!storage.loaded && storage.error ? null : !storage.loaded ? (
          <p role="status">Loading storage configuration…</p>
        ) : form.storageMode !== 'managed' ? (
          <p role="note">
            This installation reports a legacy storage configuration. Keep its data and keys, and use the matching
            previous release to export or migrate it. Current deployment commands use PostgreSQL and S3.
          </p>
        ) : (
          <>
            <div className="app-settings-field-grid">
              <StorageField label="Object storage bucket" value={form.objectStorageBucket} />
              <StorageField
                label="Object storage endpoint"
                value={form.objectStorageEndpoint || 'AWS S3 regional endpoint'}
              />
              <StorageField label="Object storage region" value={form.objectStorageRegion} />
              <StorageField label="Workflow object prefix" value={form.objectStoragePrefix} />
              <StorageField
                label="S3 address style"
                value={form.objectStorageForcePathStyle ? 'Path style' : 'Virtual host'}
              />
              <StorageField label="Object storage access key ID" value={form.storageAccessKeyId} />
              <StorageField
                label="Object storage secret access key"
                hidden
                value={form.storageAccessKeyConfigured ? 'Configured (hidden)' : 'Not configured'}
              />
              <StorageField
                label="PostgreSQL connection string"
                hidden
                value={form.databaseConnectionStringConfigured ? 'Configured (hidden)' : 'Not configured'}
              />
              <StorageField
                label="PostgreSQL SSL"
                value={
                  form.databaseSslMode === 'verify-full'
                    ? 'Verify full'
                    : form.databaseSslMode === 'require'
                      ? 'Require'
                      : 'Disabled'
                }
              />
            </div>
            <p className="app-settings-field-help">Secret values are never returned to this page.</p>
          </>
        )}
      </section>
      <section className="app-settings-section" aria-label="Choose local or external storage">
        <h3>Local or external storage</h3>
        <p>
          <code>local-storage</code> starts private PostgreSQL and MinIO automatically.
          <code> external-storage</code> connects to PostgreSQL and S3-compatible services you provide. Choose the mode
          when starting Rivet, not in this panel.
        </p>
        <h3>How to use external storage</h3>
        <ol>
          <li>
            Create a dedicated PostgreSQL database and an S3 bucket. Set the selected tier’s
            <code> RIVET_DEV_</code>, <code>RIVET_STAGING_</code> or <code>RIVET_PROD_</code> database and S3 connection
            values in the shared <code>.env</code>. Use <code>deploy/studio-server/.env.example</code> as the reference.
          </li>
          <li>
            Stop the current local deployment with its launcher’s <code>--stop</code> option. Keep its data and
            encryption keys.
          </li>
          <li>
            Start the external deployment, for example <code>yarn studio-server:dev:external-storage</code>. Staging and
            production also require the matching release manifest and installation confirmation. Leave the default
            installation names in place, or use a distinct name for the external installation.
          </li>
        </ol>
        <p role="note">
          Starting an external deployment does not move existing data. Keep the local installation until a supported
          transfer is complete and verified. Restore legacy backup below accepts original v1 legacy archives; it is not
          a PostgreSQL/S3 backup or a general local-to-external transfer. Changing connections for an existing
          installation requires a coordinated operator procedure.
        </p>
      </section>
      {storage.loaded && form.deploymentManaged && form.storageMode === 'managed' && <LegacyRestorePanel />}
    </div>
  );
}
