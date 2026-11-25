import assert from 'node:assert/strict';
import test from 'node:test';
import { PapercutObserver } from '../../extensions/pstack/papercut-observer.ts';

test('trails a call of 10 seconds or more with its time alone', () => {
  const observer = new PapercutObserver();
  observer.start('slow', 1000);
  observer.start('minute', 0);
  assert.equal(observer.finish('slow', 13_000), '[pstack: took 12s]');
  assert.equal(observer.finish('minute', 65_000), '[pstack: took 1m 5s]');
});

test('leaves a call under 10 seconds alone', () => {
  const observer = new PapercutObserver();
  observer.start('fast', 0);
  assert.equal(observer.finish('fast', 9_999), undefined);
});

test('tracks concurrent calls by id, not by completion order', () => {
  const observer = new PapercutObserver();
  observer.start('long', 0);
  observer.start('short', 9_000);
  assert.equal(observer.finish('short', 10_000), undefined);
  assert.equal(observer.finish('long', 10_000), '[pstack: took 10s]');
  assert.equal(observer.finish('long', 30_000), undefined, 'a call is trailed once');
});

test('ignores results that have no matching start event', () => {
  assert.equal(new PapercutObserver().finish('unknown', 60_000), undefined);
});
