import assert from 'node:assert/strict';
import test from 'node:test';
import { type Project, serializeProject } from '@valerypopoff/rivet2-core';
import { createEmptyEvaluationProjectData, serializeEvaluationProjectData } from '@valerypopoff/rivet2-evaluations';

const emptyEvaluationFile = { evaluationData: createEmptyEvaluationProjectData(), evaluationDatasets: [] };
import { BrowserIOProvider } from './BrowserIOProvider.js';
import { openBrowserFile } from './browserFileInput.js';

const testProject = {
  metadata: {
    id: 'project-id',
    title: 'Project',
    description: '',
  },
  graphs: {},
  plugins: [],
} as unknown as Project;

test('BrowserIOProvider support only depends on browser save picker support', () => {
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
    } as unknown as typeof window;

    assert.equal(BrowserIOProvider.isSupported(), true);

    globalThis.window = {} as typeof window;

    assert.equal(BrowserIOProvider.isSupported(), false);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider can save back to a project file handle after save-as', async () => {
  const originalWindow = globalThis.window;
  const writes: string[] = [];
  let saveOptions: SaveFilePickerOptions | undefined;
  const fileHandle = {
    name: 'project.rivet-project',
    createWritable: async () => ({
      write: async (contents: string) => {
        writes.push(contents);
      },
      close: async () => {},
    }),
  };

  try {
    globalThis.window = {
      showSaveFilePicker: async (options?: SaveFilePickerOptions) => {
        saveOptions = options;
        return fileHandle;
      },
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();
    const path = await provider.saveProjectData(testProject);

    if (!path) {
      throw new Error('Expected saveProjectData to return a browser project path');
    }
    assert.match(path, /project\.rivet-project$/);
    assert.notEqual(path, fileHandle.name);
    assert.equal(saveOptions?.suggestedName, 'Project.rivet-project');
    assert.equal(Object.prototype.hasOwnProperty.call(saveOptions, 'types'), false);
    assert.equal(provider.canSaveProjectDataNoPrompt(path), true);

    await provider.saveProjectDataNoPrompt(
      {
        ...testProject,
        metadata: {
          ...testProject.metadata,
          title: 'Updated Project',
        },
      },
      path,
    );

    assert.equal(writes.length, 2);
    assert.match(writes[1]!, /Updated Project/);
    assert.doesNotMatch(writes[0]!, /"evaluations"/u);
    assert.doesNotMatch(writes[1]!, /"evaluations"/u);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider treats cancelling the save picker as a cancelled Save As', async () => {
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      showSaveFilePicker: async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      },
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();
    assert.equal(await provider.saveProjectData(testProject), undefined);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider remembers project file handles from supported browser open picker', async () => {
  const originalWindow = globalThis.window;
  const serializedProject = serializeProject(testProject, {
    evaluations: serializeEvaluationProjectData(emptyEvaluationFile.evaluationData),
  }) as string;
  let openOptions: OpenFilePickerOptions | undefined;
  const file = {
    name: 'opened-project.rivet-project',
    text: async () => serializedProject,
  } as File;
  const fileHandle = {
    name: file.name,
    getFile: async () => file,
  };

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
      showOpenFilePicker: async (options?: OpenFilePickerOptions) => {
        openOptions = options;
        return [fileHandle];
      },
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();
    let loadedPath: string | undefined;

    await provider.loadProjectData(({ path }) => {
      loadedPath = path;
    });

    if (!loadedPath) {
      throw new Error('Expected loadProjectData to return a browser project path');
    }
    assert.match(loadedPath, /opened-project\.rivet-project$/);
    assert.notEqual(loadedPath, file.name);
    assert.equal(openOptions?.multiple, false);
    assert.equal(Object.prototype.hasOwnProperty.call(openOptions, 'types'), false);
    assert.equal(provider.canSaveProjectDataNoPrompt(loadedPath), true);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider requests write permission only when saving an opened project handle', async () => {
  const originalWindow = globalThis.window;
  const writes: string[] = [];
  const permissionRequests: Array<'read' | 'readwrite' | undefined> = [];
  const serializedProject = serializeProject(testProject, {
    evaluations: serializeEvaluationProjectData(emptyEvaluationFile.evaluationData),
  }) as string;
  const file = {
    name: 'opened-project.rivet-project',
    text: async () => serializedProject,
  } as File;
  let readWritePermission: PermissionState = 'prompt';
  const fileHandle = {
    name: file.name,
    getFile: async () => file,
    queryPermission: async ({ mode }: { mode?: 'read' | 'readwrite' } = {}) =>
      mode === 'readwrite' ? readWritePermission : 'granted',
    requestPermission: async ({ mode }: { mode?: 'read' | 'readwrite' } = {}) => {
      permissionRequests.push(mode);

      if (mode === 'readwrite') {
        readWritePermission = 'granted';
      }

      return readWritePermission;
    },
    createWritable: async () => ({
      write: async (contents: string) => {
        writes.push(contents);
      },
      close: async () => {},
    }),
  };

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
      showOpenFilePicker: async () => [fileHandle],
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();
    let loadedPath: string | undefined;

    await provider.loadProjectData(({ path }) => {
      loadedPath = path;
    });

    if (!loadedPath) {
      throw new Error('Expected loadProjectData to return a browser project path');
    }
    assert.equal(provider.canSaveProjectDataNoPrompt(loadedPath), true);
    assert.deepEqual(permissionRequests, []);

    await provider.saveProjectDataNoPrompt(
      {
        ...testProject,
        metadata: {
          ...testProject.metadata,
          title: 'Updated Project',
        },
      },
      loadedPath,
    );

    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /Updated Project/);
    assert.deepEqual(permissionRequests, ['readwrite']);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider surfaces denied write permission when saving an opened project handle', async () => {
  const originalWindow = globalThis.window;
  const serializedProject = serializeProject(testProject, {
    evaluations: serializeEvaluationProjectData(emptyEvaluationFile.evaluationData),
  }) as string;
  const file = {
    name: 'readonly-project.rivet-project',
    text: async () => serializedProject,
  } as File;
  const fileHandle = {
    name: file.name,
    getFile: async () => file,
    queryPermission: async ({ mode }: { mode?: 'read' | 'readwrite' } = {}) =>
      mode === 'readwrite' ? 'prompt' : 'granted',
    requestPermission: async ({ mode }: { mode?: 'read' | 'readwrite' } = {}) =>
      mode === 'readwrite' ? 'denied' : 'granted',
    createWritable: async () => ({
      write: async () => {},
      close: async () => {},
    }),
  };

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
      showOpenFilePicker: async () => [fileHandle],
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();
    let loadedPath: string | undefined;

    await provider.loadProjectData(({ path }) => {
      loadedPath = path;
    });

    if (!loadedPath) {
      throw new Error('Expected loadProjectData to return a browser project path');
    }
    assert.match(loadedPath, /readonly-project\.rivet-project$/);
    assert.equal(provider.canSaveProjectDataNoPrompt(loadedPath), true);
    const projectPath = loadedPath;

    await assert.rejects(
      () => provider.saveProjectDataNoPrompt(testProject, projectPath),
      /Browser write permission was not granted/,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider rejects non-project files selected from the browser file handle picker', async () => {
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
      showOpenFilePicker: async () => [
        {
          name: '123.rivet-data',
          getFile: async () => {
            throw new Error('Should not read non-project file handles');
          },
        },
      ],
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();

    await assert.rejects(
      () => provider.loadProjectData(() => {}),
      /Expected a \.rivet-project project file, but "123\.rivet-data" was selected/,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider reports file handle read failures without opening a second picker', async () => {
  const originalWindow = globalThis.window;

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
      showOpenFilePicker: async () => [
        {
          name: 'blocked-project.rivet-project',
          queryPermission: async () => 'granted',
          getFile: async () => {
            throw new DOMException('The request is not allowed by the user agent.', 'SecurityError');
          },
        },
      ],
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();

    await assert.rejects(
      () => provider.loadProjectData(() => {}),
      /Browser could not read "blocked-project\.rivet-project" from the file picker/,
    );
  } finally {
    globalThis.window = originalWindow;
  }
});

test('BrowserIOProvider falls back to standard file input when browser file handle picker is unavailable', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const serializedProject = serializeProject(testProject, {
    evaluations: serializeEvaluationProjectData(emptyEvaluationFile.evaluationData),
  }) as string;
  const selectedFile = {
    name: 'fallback-project.rivet-project',
    text: async () => serializedProject,
  } as File;

  try {
    globalThis.window = {
      showSaveFilePicker: () => undefined,
    } as unknown as typeof window;

    globalThis.document = {
      createElement: (tagName: string) => {
        assert.equal(tagName, 'input');

        const input: {
          accept: string;
          click: () => void;
          files: File[];
          onchange: (() => void) | null;
          oncancel: (() => void) | null;
          remove: () => void;
          style: { display: string };
          type: string;
        } = {
          accept: '',
          click() {
            queueMicrotask(() => input.onchange?.());
          },
          files: [selectedFile],
          onchange: null,
          oncancel: null,
          remove: () => {},
          style: { display: '' },
          type: '',
        };

        return input as unknown as HTMLInputElement;
      },
      body: {
        appendChild: (input: HTMLInputElement) => input,
      },
    } as unknown as Document;

    const provider = new BrowserIOProvider();
    let loadedPath: string | undefined;

    await provider.loadProjectData(({ path }) => {
      loadedPath = path;
    });

    assert.equal(loadedPath, selectedFile.name);
    assert.equal(provider.canSaveProjectDataNoPrompt(selectedFile.name), false);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test('BrowserIOProvider stores same-name project file handles as separate save targets', async () => {
  const originalWindow = globalThis.window;
  const fileHandle = {
    name: 'project.rivet-project',
    createWritable: async () => ({
      write: async () => {},
      close: async () => {},
    }),
  };

  try {
    globalThis.window = {
      showSaveFilePicker: async () => fileHandle,
    } as unknown as typeof window;

    const provider = new BrowserIOProvider();
    const firstPath = await provider.saveProjectData(testProject);
    const secondPath = await provider.saveProjectData(testProject);

    assert.ok(firstPath);
    assert.ok(secondPath);
    assert.notEqual(firstPath, secondPath);
    assert.equal(provider.canSaveProjectDataNoPrompt(firstPath), true);
    assert.equal(provider.canSaveProjectDataNoPrompt(secondPath), true);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('openBrowserFile resolves the selected file from a standard file input', async () => {
  const originalDocument = globalThis.document;
  const selectedFile = { name: 'project.rivet-project' } as File;
  type FakeFileInput = {
    accept: string;
    click: () => void;
    files: File[];
    onchange: (() => void) | null;
    oncancel: (() => void) | null;
    remove: () => void;
    removed: boolean;
    style: { display: string };
    type: string;
  };
  const createdInputs: FakeFileInput[] = [];

  try {
    globalThis.document = {
      createElement: (tagName: string) => {
        assert.equal(tagName, 'input');

        const input: FakeFileInput = {
          accept: '',
          files: [selectedFile],
          onchange: null,
          oncancel: null,
          remove() {
            this.removed = true;
          },
          removed: false,
          style: { display: '' },
          type: '',
          click() {
            queueMicrotask(() => this.onchange?.());
          },
        };
        createdInputs.push(input);

        return input;
      },
      body: {
        appendChild: (input: FakeFileInput) => input,
      },
    } as unknown as Document;

    const file = await openBrowserFile({ accept: '.rivet-project' });
    const input = createdInputs[0];

    assert.equal(file, selectedFile);
    assert.ok(input);
    assert.equal(input.type, 'file');
    assert.equal(input.accept, '.rivet-project');
    assert.equal(input.style.display, 'none');
    assert.equal(input.removed, true);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('openBrowserFile resolves undefined and cleans up when file selection is cancelled', async () => {
  const originalDocument = globalThis.document;
  let removed = false;

  try {
    globalThis.document = {
      createElement: () => {
        const input: {
          accept: string;
          click: () => void;
          files: File[];
          onchange: (() => void) | null;
          oncancel: (() => void) | null;
          remove: () => void;
          style: { display: string };
          type: string;
        } = {
          accept: '',
          click() {
            queueMicrotask(() => input.oncancel?.());
          },
          files: [],
          onchange: null,
          oncancel: null,
          remove() {
            removed = true;
          },
          style: { display: '' },
          type: '',
        };

        return input as unknown as HTMLInputElement;
      },
      body: {
        appendChild: (input: HTMLInputElement) => input,
      },
    } as unknown as Document;

    const file = await openBrowserFile();

    assert.equal(file, undefined);
    assert.equal(removed, true);
  } finally {
    globalThis.document = originalDocument;
  }
});
