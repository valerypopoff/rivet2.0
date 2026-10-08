import '../../shims/install-process-shim';

self.addEventListener('message', (event) => {
  void handleMessage(event);
});

async function handleMessage(event: MessageEvent) {
  const { id, type, data } = event.data;

  try {
    const payload =
      typeof data === 'object' && data != null && 'serializedProject' in data
        ? (data as { serializedProject: unknown; path?: string; datasetsContents?: string | null })
        : { serializedProject: data, path: undefined };

    if (type === 'deserializeProject') {
      const { deserializeProject } = await import('@valerypopoff/rivet2-core/serialization');
      const [project] = deserializeProject(payload.serializedProject, payload.path);
      self.postMessage({ id, type: 'deserializeProject:result', result: project });
      return;
    }

    if (type === 'deserializeHostedProjectPayload') {
      const { parseHostedProjectPayload } = await import('./hostedProjectPayload');
      self.postMessage({
        id,
        type: 'deserializeHostedProjectPayload:result',
        result: parseHostedProjectPayload(payload.serializedProject, payload.path, payload.datasetsContents),
      });
    }
  } catch (error) {
    const responseType =
      type === 'deserializeHostedProjectPayload'
        ? 'deserializeHostedProjectPayload:result'
        : 'deserializeProject:result';
    self.postMessage({ id, type: responseType, error });
  }
}
