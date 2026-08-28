import '../../shims/install-process-shim';

self.addEventListener('message', (event) => {
  void handleMessage(event);
});

async function handleMessage(event: MessageEvent) {
  const { id, type, data } = event.data;

  try {
    const { deserializeProject } = await import('@valerypopoff/rivet2-core');
    const payload = typeof data === 'object' && data != null && 'serializedProject' in data
      ? data as { serializedProject: unknown; path?: string }
      : { serializedProject: data, path: undefined };

    if (type === 'deserializeProject') {
      const [project] = deserializeProject(payload.serializedProject, payload.path);
      self.postMessage({ id, type: 'deserializeProject:result', result: project });
      return;
    }

    if (type === 'deserializeHostedProjectPayload') {
      const [project, attachedData] = deserializeProject(payload.serializedProject, payload.path);
      self.postMessage({
        id,
        type: 'deserializeHostedProjectPayload:result',
        result: {
          project,
          serializedEvaluationData: attachedData.evaluations ?? null,
        },
      });
    }
  } catch (error) {
    const responseType = type === 'deserializeHostedProjectPayload'
      ? 'deserializeHostedProjectPayload:result'
      : 'deserializeProject:result';
    self.postMessage({ id, type: responseType, error });
  }
}
