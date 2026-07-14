import { useMemo } from 'react';

import type { HostedRouteConfig } from '../types';
import {
  executorUrlOverrideSettingsResource,
  nodeExecutorProxySettingsResource,
} from '../appSettingsApi';
import { fetchHostedConfig } from '../workflowApi';
import type { ExecutorUrlOverrideSettingsForm, NodeExecutorProxySettingsForm } from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultProxyForm: NodeExecutorProxySettingsForm = {
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
};

const defaultUrlForm: ExecutorUrlOverrideSettingsForm = {
  executorWsUrl: '',
  remoteDebuggerDefaultWs: '',
};

export function useNodeExecutorForms(
  enabled: boolean,
  routeConfig: HostedRouteConfig,
  onRouteConfigChange?: (config: HostedRouteConfig) => void,
) {
  const proxy = useSettingsFormResource({
    defaultForm: defaultProxyForm,
    enabled,
    resource: nodeExecutorProxySettingsResource,
    toForm: (settings) => ({
      httpProxy: settings.httpProxy,
      httpsProxy: settings.httpsProxy,
      noProxy: settings.noProxy,
    }),
  });
  const urls = useSettingsFormResource({
    afterSave: async () => {
      const activeConfig = await fetchHostedConfig();
      onRouteConfigChange?.({ ...routeConfig, ...activeConfig });
    },
    defaultForm: defaultUrlForm,
    enabled,
    resource: executorUrlOverrideSettingsResource,
    toForm: (settings) => ({
      executorWsUrl: settings.executorWsUrl,
      remoteDebuggerDefaultWs: settings.remoteDebuggerDefaultWs,
    }),
  });
  const proxyDraft = useMemo(() => ({
    httpProxy: proxy.form.httpProxy.trim(),
    httpsProxy: proxy.form.httpsProxy.trim(),
    noProxy: proxy.form.noProxy.trim(),
  }), [proxy.form]);
  const urlDraft = useMemo(() => ({
    executorWsUrl: urls.form.executorWsUrl.trim(),
    remoteDebuggerDefaultWs: urls.form.remoteDebuggerDefaultWs.trim(),
  }), [urls.form]);

  return {
    proxy: {
      ...proxy,
      changed: (
        proxyDraft.httpProxy !== proxy.baseline.httpProxy ||
        proxyDraft.httpsProxy !== proxy.baseline.httpsProxy ||
        proxyDraft.noProxy !== proxy.baseline.noProxy
      ),
      revert: () => proxy.resetForm(),
      save: () => proxy.save(proxyDraft),
    },
    urls: {
      ...urls,
      changed: (
        urlDraft.executorWsUrl !== urls.baseline.executorWsUrl ||
        urlDraft.remoteDebuggerDefaultWs !== urls.baseline.remoteDebuggerDefaultWs
      ),
      revert: () => urls.resetForm(),
      save: () => urls.save(urlDraft),
    },
  };
}
