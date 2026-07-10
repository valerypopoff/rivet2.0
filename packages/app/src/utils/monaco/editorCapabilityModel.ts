import { shouldHighlightJsStyleComments } from './commentRangeScanner.js';
import type { EditorInterpolationSyntax } from './interpolationDiagnostics.js';

export type CodeEditorCapabilities = {
  commentHighlighting?: boolean;
  definitionNavigation?: boolean;
  interpolation?: EditorInterpolationSyntax | false;
  spellcheckAction?: boolean;
  textTools?: boolean;
};

export type ResolvedCodeEditorCapabilities = {
  commentHighlighting: boolean;
  definitionNavigation: boolean;
  interpolation?: EditorInterpolationSyntax;
  spellcheckAction: boolean;
  textTools: boolean;
};

export function resolveCodeEditorCapabilities(options: {
  capabilities?: CodeEditorCapabilities;
  enableSpellcheckAction: boolean;
  interpolationSyntax?: EditorInterpolationSyntax;
  language?: string;
}): ResolvedCodeEditorCapabilities {
  const { capabilities, enableSpellcheckAction, interpolationSyntax, language } = options;

  return {
    commentHighlighting: capabilities?.commentHighlighting ?? shouldHighlightJsStyleComments(language),
    definitionNavigation: capabilities?.definitionNavigation ?? true,
    interpolation:
      capabilities?.interpolation === false ? undefined : capabilities?.interpolation ?? interpolationSyntax,
    spellcheckAction: capabilities?.spellcheckAction ?? enableSpellcheckAction,
    textTools: capabilities?.textTools ?? true,
  };
}
