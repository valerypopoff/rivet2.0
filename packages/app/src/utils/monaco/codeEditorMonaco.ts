import { cloneDeep } from 'lodash-es';
import * as monaco from 'monaco-editor';

import 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/goToCommands.js';
import {
  conf as markdownConf,
  language as markdownLanguage,
} from 'monaco-editor/esm/vs/basic-languages/markdown/markdown';
import { getMarkdownFoldingRanges, MARKDOWN_FOLDING_LANGUAGES } from './markdownFoldingRanges.js';
import { getJsonSchemaRequiredFieldDefinitionAtOffset } from './jsonSchemaRequiredDefinition.js';
import { isMacOSPlatform } from '../platform/os.js';
import { installAmbiguousUnicodeHighlightCommand } from './unicodeHighlighting.js';

export { monaco };

installAmbiguousUnicodeHighlightCommand(monaco.editor);

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
let jsonSchemaRequiredDefinitionProviderRegistered = false;

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

function offsetRangeToMonacoRange(model: monaco.editor.ITextModel, start: number, end: number): monaco.Range {
  const startPosition = model.getPositionAt(start);
  const endPosition = model.getPositionAt(end);

  return new monaco.Range(startPosition.lineNumber, startPosition.column, endPosition.lineNumber, endPosition.column);
}

function registerJsonSchemaRequiredDefinitionProvider(): void {
  if (jsonSchemaRequiredDefinitionProviderRegistered) {
    return;
  }

  jsonSchemaRequiredDefinitionProviderRegistered = true;

  monaco.languages.registerDefinitionProvider('json', {
    provideDefinition(model, position) {
      const definition = getJsonSchemaRequiredFieldDefinitionAtOffset(model.getValue(), model.getOffsetAt(position));

      if (!definition) {
        return undefined;
      }

      const targetRange = offsetRangeToMonacoRange(model, definition.targetKeyStart, definition.targetKeyEnd);

      return [
        {
          uri: model.uri,
          originSelectionRange: offsetRangeToMonacoRange(
            model,
            definition.requiredStringStart,
            definition.requiredStringEnd,
          ),
          range: targetRange,
          targetSelectionRange: targetRange,
        },
      ];
    },
  });
}

type JsonSchemaDefinitionModifierEvent = Pick<monaco.IMouseEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

const JSON_SCHEMA_DEFINITION_HOVER_SUPPRESSED_CLASS = 'rivet-json-schema-definition-hover-suppressed';

function hasJsonSchemaDefinitionClickModifier(event: JsonSchemaDefinitionModifierEvent): boolean {
  if (event.altKey || event.shiftKey) {
    return false;
  }

  return isMacOSPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function installJsonSchemaRequiredDefinitionNavigation(
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.IDisposable {
  if (editor.getModel()?.getLanguageId() !== 'json') {
    return { dispose() {} };
  }

  let hoverSuppressed = false;

  const setHoverSuppressed = (suppressed: boolean) => {
    if (hoverSuppressed === suppressed) {
      return;
    }

    hoverSuppressed = suppressed;
    editor.getDomNode()?.classList.toggle(JSON_SCHEMA_DEFINITION_HOVER_SUPPRESSED_CLASS, suppressed);
    editor.updateOptions({ hover: { enabled: !suppressed } });
  };

  const shouldSuppressHover = (event: JsonSchemaDefinitionModifierEvent) =>
    editor.getModel()?.getLanguageId() === 'json' && hasJsonSchemaDefinitionClickModifier(event);

  const disposables = [
    editor.onMouseMove((event) => {
      setHoverSuppressed(shouldSuppressHover(event.event));
    }),
    editor.onMouseLeave(() => {
      setHoverSuppressed(false);
    }),
    editor.onKeyDown((event) => {
      setHoverSuppressed(shouldSuppressHover(event));
    }),
    editor.onKeyUp((event) => {
      setHoverSuppressed(shouldSuppressHover(event));
    }),
    editor.onDidChangeModel(() => {
      setHoverSuppressed(false);
    }),
    editor.onDidBlurEditorWidget(() => {
      setHoverSuppressed(false);
    }),
    editor.onMouseDown((event) => {
      const model = editor.getModel();
      const position = event.target.position;

      if (
        !model ||
        model.getLanguageId() !== 'json' ||
        !position ||
        !event.event.leftButton ||
        !hasJsonSchemaDefinitionClickModifier(event.event)
      ) {
        return;
      }

      const definition = getJsonSchemaRequiredFieldDefinitionAtOffset(model.getValue(), model.getOffsetAt(position));

      if (!definition) {
        return;
      }

      const targetRange = offsetRangeToMonacoRange(model, definition.targetKeyStart, definition.targetKeyEnd);

      event.event.preventDefault();
      event.event.stopPropagation();
      editor.focus();
      editor.setSelection(targetRange, 'rivet.jsonSchemaRequiredDefinitionNavigation');
      editor.revealRangeInCenterIfOutsideViewport(targetRange, monaco.editor.ScrollType.Smooth);
    }),
  ];

  return {
    dispose() {
      setHoverSuppressed(false);
      disposables.forEach((disposable) => disposable.dispose());
    },
  };
}

export function ensureCodeEditorMonacoLanguages(): void {
  registerPromptInterpolationLanguage();
  registerPromptInterpolationMarkdownLanguage();
  registerMarkdownFoldingProviders();
  registerJsonSchemaRequiredDefinitionProvider();
  definePromptInterpolationThemes();
}
