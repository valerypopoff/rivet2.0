import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(iframe = false) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  class Element {
    children = [];
    style = {};
    setAttribute() {}
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
  }
  class Script extends Element {
    type = 'module';
  }
  const root = new Element();
  const messages = [];
  let listener;
  let reloads = 0;
  const window = {
    location: {
      origin: 'https://fixture.test',
      reload() {
        reloads++;
      },
    },
    addEventListener(type, handler, capture) {
      assert.equal(type, 'error');
      assert.equal(capture, true);
      listener = handler;
    },
  };
  window.parent = iframe ? { postMessage: (...args) => messages.push(args) } : window;
  runInNewContext(script, {
    window,
    HTMLScriptElement: Script,
    document: { getElementById: () => root, createElement: () => new Element() },
  });
  return {
    window,
    root,
    messages,
    fail: () => listener({ target: new Script() }),
    unrelated: () => listener({ target: window }),
    reloads: () => reloads,
  };
}

test('entry resource failure renders a dependency-free retry and informs only the owning parent', async () => {
  const f = await fixture(true);
  f.fail();
  assert.equal(f.window.__rivetEditorBootstrapState, 'failed');
  assert.equal(f.root.children[0].children[0].textContent, 'Rivet could not finish loading');
  assert.deepEqual(JSON.parse(JSON.stringify(f.messages[0][0])), { type: 'editor-initialization-failed' });
  assert.equal(f.messages[0][1], 'https://fixture.test');
  assert.equal(f.reloads(), 0, 'Failure must not start a reload loop');
  f.root.children[0].children[2].onclick();
  assert.equal(f.reloads(), 1);
});

test('runtime errors and late resource failures do not replace a working editor', async () => {
  const f = await fixture();
  f.unrelated();
  assert.equal(f.root.children.length, 0);
  f.window.__rivetEditorBootstrapState = 'ready';
  f.fail();
  assert.equal(f.root.children.length, 0);
  assert.equal(f.window.__rivetEditorBootstrapState, 'ready');
});
