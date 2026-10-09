import assert from 'node:assert/strict';
import test from 'node:test';
import { canTrapHostedFocus, getHostedReturnFocus } from '../shims/hosted-focus-lock';

function activeElement(embedded: boolean, focused: boolean): HTMLElement {
  const window = { parent: {} };
  if (!embedded) window.parent = window;
  return {
    ownerDocument: { defaultView: window, hasFocus: () => focused },
  } as unknown as HTMLElement;
}

test('hosted focus policy yields only when an embedded document loses focus', () => {
  assert.equal(canTrapHostedFocus(activeElement(true, false)), false);
  assert.equal(canTrapHostedFocus(activeElement(true, true)), true);
  // Dashboard and standalone dialogs retain the underlying library policy.
  assert.equal(canTrapHostedFocus(activeElement(false, true)), true);
  assert.equal(canTrapHostedFocus(activeElement(false, false)), true);
});

test('closing an unfocused iframe dialog never restores focus', () => {
  const element = activeElement(true, false);
  assert.equal(getHostedReturnFocus(element, true), false);
  assert.equal(getHostedReturnFocus(element, { preventScroll: true }), false);
  assert.equal(
    getHostedReturnFocus(element, () => assert.fail('background restoration is skipped')),
    false,
  );
});

test('focused iframe and standalone dialogs preserve return-focus options and callbacks', () => {
  for (const element of [activeElement(true, true), activeElement(false, true), activeElement(false, false)]) {
    assert.equal(getHostedReturnFocus(element, undefined), false);
    assert.equal(getHostedReturnFocus(element, false), false);
    assert.equal(getHostedReturnFocus(element, true), true);
    const options = { preventScroll: true };
    assert.equal(getHostedReturnFocus(element, options), options);
    assert.equal(
      getHostedReturnFocus(element, (target) => {
        assert.equal(target, element);
        return options;
      }),
      options,
    );
  }
});

test('hosted focus policy preserves caller exceptions and receives the original element', () => {
  for (const embedded of [false, true]) {
    const element = activeElement(embedded, true);
    assert.equal(
      canTrapHostedFocus(element, (received) => {
        assert.equal(received, element);
        return false;
      }),
      false,
    );
    assert.equal(
      canTrapHostedFocus(element, () => true),
      true,
    );
  }
  assert.equal(
    canTrapHostedFocus(activeElement(true, false), () => {
      assert.fail('An unfocused iframe must not activate caller focus handling');
    }),
    false,
  );
});
