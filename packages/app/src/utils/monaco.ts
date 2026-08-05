import './monaco/monacoWorkerEnvironment.js';
import * as monaco from 'monaco-editor';

import {
  conf as promptInterpolationMarkdownConf,
  language as promptInterpolationMarkdownLanguage,
} from './monaco/markdown';

export { monaco };

const languageContributionLoaders: Record<string, () => Promise<unknown>> = {
  json: async () => {
    await import('monaco-editor/esm/vs/language/json/monaco.contribution.js');

    const model = monaco.editor.createModel('', 'json');

    try {
      await import('monaco-editor/esm/vs/language/json/jsonMode.js');
    } finally {
      model.dispose();
    }
  },
};

const languageContributionPromises = new Map<string, Promise<unknown>>();

export function ensureMonacoLanguage(language: string): Promise<void> {
  const loadContribution = languageContributionLoaders[language];

  if (!loadContribution) {
    return Promise.resolve();
  }

  let contributionPromise = languageContributionPromises.get(language);

  if (!contributionPromise) {
    contributionPromise = loadContribution().catch((error: unknown) => {
      languageContributionPromises.delete(language);
      throw error;
    });
    languageContributionPromises.set(language, contributionPromise);
  }

  return contributionPromise.then(() => undefined);
}

const PROMPT_INTERPOLATION_BRACE_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  brackets: [['{', '}']],
  autoClosingPairs: [{ open: '{', close: '}' }],
  surroundingPairs: [{ open: '{', close: '}' }],
};

const isLanguageRegistered = (id: string) => monaco.languages.getLanguages().some((language) => language.id === id);

if (!isLanguageRegistered('prompt-interpolation')) {
  monaco.languages.register({ id: 'prompt-interpolation' });
  monaco.languages.setMonarchTokensProvider('prompt-interpolation', {
    tokenizer: {
      root: [[/\{\{[^}]+\}\}/, 'prompt-replacement']],
    },
  });
  monaco.languages.setLanguageConfiguration('prompt-interpolation', PROMPT_INTERPOLATION_BRACE_CONFIGURATION);
}

if (!isLanguageRegistered('prompt-interpolation-markdown')) {
  monaco.languages.register({ id: 'prompt-interpolation-markdown' });
  monaco.languages.setMonarchTokensProvider('prompt-interpolation-markdown', promptInterpolationMarkdownLanguage);
  monaco.languages.setLanguageConfiguration('prompt-interpolation-markdown', promptInterpolationMarkdownConf);
}

const definePITheme = (name: string, colors: { primary: string; base?: 'vs' | 'vs-dark' }) =>
  monaco.editor.defineTheme(`prompt-interpolation-${name}`, {
    base: colors.base ?? 'vs-dark',
    inherit: true,
    rules: [{ token: 'prompt-replacement', foreground: colors.primary }],
    colors: {},
  });

definePITheme('molten', { primary: 'ff9900' });
definePITheme('grapefruit', { primary: 'ff8862' });
definePITheme('taffy', { primary: 'd6c2ff' });
definePITheme('bright', { primary: '1769e0', base: 'vs' });
definePITheme('custom', { primary: 'ff9900' });
