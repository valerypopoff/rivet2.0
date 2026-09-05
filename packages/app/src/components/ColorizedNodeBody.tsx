import type { ColorizedNodeBodySpec } from '@valerypopoff/rivet2-core';
import { type FC, memo } from 'react';
import ColorizedPreformattedText from './ColorizedPreformattedText.js';

function shouldWrapColorizedNodeBody(language: string): boolean {
  return language === 'prompt-interpolation-markdown';
}

export const ColorizedNodeBody: FC<ColorizedNodeBodySpec> = memo(({ text, language, theme }) => {
  const wrapWords = shouldWrapColorizedNodeBody(language);

  return (
    <ColorizedPreformattedText
      text={text}
      language={language}
      theme={theme}
      className={wrapWords ? 'node-body-colorized-wrap' : undefined}
      wrapWords={wrapWords}
    />
  );
});

ColorizedNodeBody.displayName = 'ColorizedNodeBody';
