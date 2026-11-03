const fs = require('node:fs');
const names = ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL'];
const values = names.map((name) => {
  const value = process.env[name];
  if (!value || /[\r\n]/.test(value)) throw Error(`Missing or invalid ${name}`);
  return `${name}=${value}\n`;
});
// Runner command: OmitEcho hides its payload and masks later step environment
// dumps. Validate every value first; never emit credentials as ordinary output.
process.stdout.write(`::add-mask::${process.env.ACTIONS_RUNTIME_TOKEN.replaceAll('%', '%25')}\n`);
fs.appendFileSync(process.env.GITHUB_ENV, values.join(''));
