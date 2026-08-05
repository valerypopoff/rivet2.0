import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

type MonacoWorkerConstructor = new () => Worker;

type MonacoEnvironment = {
  getWorker?: (moduleId: string, label: string) => Worker;
};

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironment;
  __rivetMonacoWorkerEnvironmentConfigured?: boolean;
};

function getWorkerConstructor(label: string): MonacoWorkerConstructor {
  switch (label) {
    case 'css':
    case 'less':
    case 'scss':
      return CssWorker;
    case 'handlebars':
    case 'html':
    case 'razor':
      return HtmlWorker;
    case 'json':
      return JsonWorker;
    case 'javascript':
    case 'typescript':
      return TypeScriptWorker;
    default:
      return EditorWorker;
  }
}

function configureMonacoWorkerEnvironment(): void {
  const monacoGlobal = globalThis as MonacoGlobal;

  if (monacoGlobal.__rivetMonacoWorkerEnvironmentConfigured) {
    return;
  }

  monacoGlobal.MonacoEnvironment = {
    ...monacoGlobal.MonacoEnvironment,
    getWorker(_moduleId, label) {
      return new (getWorkerConstructor(label))();
    },
  };
  monacoGlobal.__rivetMonacoWorkerEnvironmentConfigured = true;
}

configureMonacoWorkerEnvironment();
