import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const aiRuntimeFiles = [
  'packages/app/src/utils/aiAssistVercelGenerator.ts',
  'packages/app/src/components/editors/custom/AiAssistEditorBase.tsx',
  'packages/app/src/hooks/useAiGraphBuilder.ts',
  'packages/app/graphs/graph-creator.rivet-project',
  'packages/app/graphs/code-node-generator.rivet-project',
];
const forbiddenPatterns = [
  { pattern: /\bchatAnthropic\b/, reason: 'legacy Anthropic Chat node' },
  { pattern: /\bstreamChatCompletions\b/, reason: 'legacy Chat transport' },
  { pattern: /\bopenAiEndpoint\b|\bOPENAI_ENDPOINT\b/, reason: 'legacy endpoint override' },
  { pattern: /\.openai\.azure\.com/i, reason: 'Azure-specific endpoint' },
  { pattern: /(?:"type"\s*:\s*"chat"|\]:chat(?:\s|\"))/, reason: 'legacy Chat node stored in an AI helper graph' },
];

const failures = [];
for (const file of aiRuntimeFiles) {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(source)) failures.push(`${file}: ${reason}`);
  }
}

const legacyGraphBuilderHost = readFileSync(join(repoRoot, 'packages/app/src/hooks/useAiGraphBuilder.ts'), 'utf8');
for (const { pattern, reason } of [
  { pattern: /\bsetGraph\s*\(/, reason: 'legacy Graph Builder publishes editor graph state during generation' },
  { pattern: /\bclearCurrentGraphHistory\b/, reason: 'legacy Graph Builder clears editor history during generation' },
  { pattern: /\buseAtom\s*\(\s*graphState\s*\)/, reason: 'legacy Graph Builder owns authoritative graph mutation' },
]) {
  if (pattern.test(legacyGraphBuilderHost)) {
    failures.push(`packages/app/src/hooks/useAiGraphBuilder.ts: ${reason}`);
  }
}
if (
  !legacyGraphBuilderHost.includes('runLegacyGraphBuilderDraft') ||
  !legacyGraphBuilderHost.includes('tryCommitGraphBuilderDraftState')
) {
  failures.push(
    'packages/app/src/hooks/useAiGraphBuilder.ts: legacy Graph Builder must use the private draft runner and atomic commit gateway',
  );
}

if (failures.length > 0) {
  console.error('AI generation must remain on the Chat V2 provider/request path:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('AI generation uses the Chat V2 runtime without legacy Chat or Azure endpoint seams.');
}
