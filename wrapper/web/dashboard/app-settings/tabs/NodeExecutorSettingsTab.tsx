import TextField from '@atlaskit/textfield';

import type { HostedRouteConfig } from '../../types';
import type { ExecutorUrlOverrideSettingsForm, NodeExecutorProxySettingsForm } from '../model';
import { SettingsActions } from '../SettingsControls';
import type { useNodeExecutorForms } from '../useNodeExecutorForms';

export function NodeExecutorSettingsTab({
  nodeExecutor,
  routeConfig,
}: {
  nodeExecutor: ReturnType<typeof useNodeExecutorForms>;
  routeConfig: HostedRouteConfig;
}) {
  const { proxy, urls } = nodeExecutor;
  const updateProxy = <K extends keyof NodeExecutorProxySettingsForm>(key: K, value: NodeExecutorProxySettingsForm[K]) => {
    proxy.setForm((form) => ({ ...form, [key]: value }));
    proxy.clearFeedback();
  };
  const updateUrl = <K extends keyof ExecutorUrlOverrideSettingsForm>(key: K, value: ExecutorUrlOverrideSettingsForm[K]) => {
    urls.setForm((form) => ({ ...form, [key]: value }));
    urls.clearFeedback();
  };

  return (
    <div className="project-settings-tab-panel app-settings-proxy-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Node executor proxy">
        <div className="app-settings-field-grid" aria-busy={!proxy.loaded || proxy.loading || proxy.saving}>
          <label className="app-settings-field"><span className="app-settings-field-label">HTTP_PROXY</span><TextField aria-label="HTTP_PROXY" value={proxy.form.httpProxy} isDisabled={!proxy.loaded || proxy.loading || proxy.saving} placeholder="http://proxy.example.internal:3128" onChange={(event) => updateProxy('httpProxy', event.currentTarget.value)} /></label>
          <label className="app-settings-field"><span className="app-settings-field-label">HTTPS_PROXY</span><TextField aria-label="HTTPS_PROXY" value={proxy.form.httpsProxy} isDisabled={!proxy.loaded || proxy.loading || proxy.saving} placeholder="http://proxy.example.internal:3128" onChange={(event) => updateProxy('httpsProxy', event.currentTarget.value)} /></label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">NO_PROXY</span>
            <textarea aria-label="NO_PROXY" className="project-settings-textarea app-settings-proxy-no-proxy" value={proxy.form.noProxy} disabled={!proxy.loaded || proxy.loading || proxy.saving} placeholder="localhost,127.0.0.1,::1,api,web,executor,proxy,.svc,.cluster.local" onChange={(event) => updateProxy('noProxy', event.currentTarget.value)} />
            <span className="app-settings-field-help">Include internal service names that should bypass the proxy. In Kubernetes, include cluster-local suffixes such as .svc and .cluster.local when your proxy should not handle in-cluster calls.</span>
          </label>
        </div>
        <SettingsActions changed={proxy.changed} disabled={!proxy.loaded || proxy.loading || proxy.saving} error={proxy.error} loading={proxy.saving} onRevert={proxy.revert} onSave={proxy.save} saved={proxy.saved} />
      </section>

      <section className="app-settings-section" aria-label="Websocket URL overrides">
        <div className="app-settings-section-title">Websocket URL overrides</div>
        <div className="app-settings-field-grid" aria-busy={!urls.loaded || urls.loading || urls.saving}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Node executor websocket URL override</span>
            <TextField aria-label="Node executor websocket URL override" value={urls.form.executorWsUrl} isDisabled={!urls.loaded || urls.loading || urls.saving} placeholder={routeConfig.executorWsUrl} onChange={(event) => updateUrl('executorWsUrl', event.currentTarget.value)} />
            <span className="app-settings-field-help">Optional override for the hosted editor's Node executor websocket. Leave blank to derive it from the current host. Active URL: {routeConfig.executorWsUrl || 'none'}.</span>
          </label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Remote Debugger websocket URL override</span>
            <TextField aria-label="Remote Debugger websocket URL override" value={urls.form.remoteDebuggerDefaultWs} isDisabled={!urls.loaded || urls.loading || urls.saving} placeholder={routeConfig.remoteDebuggerDefaultWs || 'No default Remote Debugger URL'} onChange={(event) => updateUrl('remoteDebuggerDefaultWs', event.currentTarget.value)} />
            <span className="app-settings-field-help">Optional override for the editor's default Remote Debugger URL. Leave blank to use the hosted latest-debugger websocket when available. Active URL: {routeConfig.remoteDebuggerDefaultWs || 'none'}.</span>
          </label>
        </div>
        <SettingsActions changed={urls.changed} disabled={!urls.loaded || urls.loading || urls.saving} error={urls.error} loading={urls.saving} onRevert={urls.revert} onSave={urls.save} saved={urls.saved} savedMessage="Saved. Reload the editor to apply websocket URL overrides to active sessions." />
      </section>
    </div>
  );
}
