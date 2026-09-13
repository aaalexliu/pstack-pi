import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeModeState,
  disabledModeState,
  enabledModeState,
  invokesPotetoMode,
  modeEntryType,
  restoreMode,
} from '../../extensions/pstack/mode.ts';

/** @param {unknown} data */
const custom = (data) => ({ type: 'custom', customType: modeEntryType, data });

test('poteto mode state is versioned and follows ordered branch snapshots', () => {
  assert.equal(restoreMode([]), disabledModeState);
  assert.equal(restoreMode([custom({ version: 1, enabled: true })]), enabledModeState);
  assert.equal(restoreMode([
    custom({ version: 1, enabled: true }),
    custom({ version: 2, enabled: false }),
    custom({ version: 1, enabled: false, extra: true }),
  ]), enabledModeState);
  assert.equal(decodeModeState({ version: 2, enabled: true }), null);
  assert.equal(decodeModeState({ version: 1, enabled: 'yes' }), null);
});

test('poteto mode invocation matches only the exact Pi skill command', () => {
  for (const text of ['/skill:poteto-mode', '/skill:poteto-mode task', '/skill:poteto-mode\n']) assert.equal(invokesPotetoMode(text), true);
  for (const text of ['/poteto-mode', ' /skill:poteto-mode', '/skill:poteto-modes', 'poteto-mode']) assert.equal(invokesPotetoMode(text), false);
});
