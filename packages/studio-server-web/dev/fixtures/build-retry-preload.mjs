// Fault injection for build-retry-process.test.mjs only; actual watcher/compiler
// processes and IPC are retained. No production test switch is introduced.
import { register } from 'node:module';

const vite = `
import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
export async function createServer() {
  const watcher = new EventEmitter();
  watcher.add = () => {};
  process.on('message', message => { if (message?.type === 'fixture-edit') watcher.emit('all', 'change', 'fixture.ts'); });
  return { watcher, close: async () => {} };
}
export async function build() {
  const control = JSON.parse(readFileSync(process.env.RIVET_BUILD_RETRY_CONTROL, 'utf8'));
  const count = readFileSync(process.env.RIVET_BUILD_RETRY_TRACE, 'utf8').trim().split('\\n').filter(Boolean).length;
  appendFileSync(process.env.RIVET_BUILD_RETRY_TRACE, JSON.stringify({ pid: process.pid })+'\\n');
  if (control.mode === 'syntax') throw Object.assign(new Error('bad source'), { code: 'PARSE_ERROR' });
  if (control.mode === 'css-transient' && count === 0)
    throw Object.assign(new Error('source mount read failed'), { code: 'PLUGIN_ERROR', errno: -5, plugin: 'vite:css', pluginCode: '@import "./fixture.css";', syscall: 'open', hook: 'transform', path: process.env.RIVET_BUILD_RETRY_SOURCE });
  if (control.mode === 'stat-transient' && count === 0)
    throw Object.assign(new Error('source mount stat failed'), { code: 'PLUGIN_ERROR', pluginCode: 'EIO', syscall: 'stat', hook: 'transform', plugin: 'vite:esbuild', path: process.env.RIVET_BUILD_RETRY_SOURCE });
  if (control.mode === 'persistent' || (control.mode === 'transient' && count === 0))
    throw Object.assign(new Error('source mount read failed'), { code: 'PLUGIN_ERROR', pluginCode: 'EIO', syscall: 'open', hook: 'load', path: process.env.RIVET_BUILD_RETRY_SOURCE });
}
`;
const viteUrl = 'data:text/javascript,' + encodeURIComponent(vite);
const loader = `export async function resolve(name, context, next) {
  return name === 'vite' ? { url: ${JSON.stringify(viteUrl)}, shortCircuit: true } : next(name, context);
}`;
register('data:text/javascript,' + encodeURIComponent(loader), import.meta.url);

// Assert actual published retry delays in the parent while keeping this process
// integration quick. This preload is inherited only by test-owned child processes.
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => setTimer(callback, Math.min(delay, 10), ...args);
