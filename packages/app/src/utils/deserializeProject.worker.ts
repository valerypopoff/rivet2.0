import { deserializeProject } from '@valerypopoff/rivet2-core/serialization';

self.addEventListener('message', (event) => {
  const { id, type, data } = event.data;

  if (type !== 'deserializeProject') {
    return;
  }

  try {
    const [project] = deserializeProject(data.serializedProject, data.path);
    self.postMessage({ id, type: 'deserializeProject:result', result: project });
  } catch (err) {
    self.postMessage({ id, type: 'deserializeProject:result', error: err });
  }
});
