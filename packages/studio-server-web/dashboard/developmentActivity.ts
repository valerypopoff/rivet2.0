// Scoped to this editor document. Count queued commands as well as active ones.
let commands = 0;
export const hasDevelopmentCommands = () => commands > 0;
export function beginDevelopmentCommand(): () => void {
  commands++;
  let finished = false;
  return () => {
    if (!finished) {
      finished = true;
      commands--;
    }
  };
}
