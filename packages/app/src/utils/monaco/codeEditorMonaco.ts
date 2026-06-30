import { cloneDeep } from 'lodash-es';
import * as monaco from 'monaco-editor';

import {
  conf as markdownConf,
  language as markdownLanguage,
} from 'monaco-editor/esm/vs/basic-languages/markdown/markdown';
import { getMarkdownFoldingRanges, MARKDOWN_FOLDING_LANGUAGES } from './markdownFoldingRanges.js';

export { monaco };

const PROMPT_INTERPOLATION_BRACE_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  brackets: [['{', '}']],
  autoClosingPairs: [{ open: '{', close: '}' }],
  surroundingPairs: [{ open: '{', close: '}' }],
};

const PROMPT_INTERPOLATION_THEMES = {
  molten: { foreground: 'ff9900', base: 'vs-dark' },
  grapefruit: { foreground: 'ff8862', base: 'vs-dark' },
  taffy: { foreground: 'd6c2ff', base: 'vs-dark' },
  bright: { foreground: '1769e0', base: 'vs' },
  custom: { foreground: 'ff9900', base: 'vs-dark' },
} as const;

function isLanguageRegistered(id: string): boolean {
  return monaco.languages.getLanguages().some((language) => language.id === id);
}

function registerPromptInterpolationLanguage(): void {
  if (isLanguageRegistered('prompt-interpolation')) {
    return;
  }

  monaco.languages.register({ id: 'prompt-interpolation' });
  monaco.languages.setMonarchTokensProvider('prompt-interpolation', {
    tokenizer: {
      root: [[/\{\{[^}]+\}\}/, 'prompt-replacement']],
    },
  });
  monaco.languages.setLanguageConfiguration('prompt-interpolation', PROMPT_INTERPOLATION_BRACE_CONFIGURATION);
}

function registerPromptInterpolationMarkdownLanguage(): void {
  if (isLanguageRegistered('prompt-interpolation-markdown')) {
    return;
  }

  const promptInterpolationMarkdownConf = cloneDeep(markdownConf);
  const promptInterpolationMarkdownLanguage = cloneDeep(markdownLanguage);
  promptInterpolationMarkdownLanguage.tokenizer.root.unshift([/\{\{[^{}]+\}\}/, 'prompt-replacement']);

  monaco.languages.register({ id: 'prompt-interpolation-markdown' });
  monaco.languages.setMonarchTokensProvider('prompt-interpolation-markdown', promptInterpolationMarkdownLanguage);
  monaco.languages.setLanguageConfiguration('prompt-interpolation-markdown', promptInterpolationMarkdownConf);
}

function definePromptInterpolationThemes(): void {
  for (const [name, { base, foreground }] of Object.entries(PROMPT_INTERPOLATION_THEMES)) {
    monaco.editor.defineTheme(`prompt-interpolation-${name}`, {
      base,
      inherit: true,
      rules: [{ token: 'prompt-replacement', foreground }],
      colors: {},
    });
  }
}

let markdownFoldingProvidersRegistered = false;

function registerMarkdownFoldingProviders(): void {
  if (markdownFoldingProvidersRegistered) {
    return;
  }

  markdownFoldingProvidersRegistered = true;

  for (const languageId of MARKDOWN_FOLDING_LANGUAGES) {
    monaco.languages.registerFoldingRangeProvider(languageId, {
      provideFoldingRanges(model) {
        return getMarkdownFoldingRanges(model.getValue()).map(({ start, end }) => ({
          start,
          end,
          kind: monaco.languages.FoldingRangeKind.Region,
        }));
      },
    });
  }
}

export function ensureCodeEditorMonacoLanguages(): void {
  registerPromptInterpolationLanguage();
  registerPromptInterpolationMarkdownLanguage();
  registerMarkdownFoldingProviders();
  definePromptInterpolationThemes();
}
