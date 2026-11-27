import assert from 'node:assert/strict';
import { test } from 'node:test';
import { median, percent, total } from './m-tally.mjs';

test('total adds every price', () => {
  assert.equal(total([{ price: 1.5 }, { price: 2 }, { price: 0.5 }]), 4);
});

test('median sorts the prices first', () => {
  assert.equal(median([{ price: 3 }, { price: 1 }, { price: 2 }]), 2);
});

test('percent is the part over the total', () => {
  assert.equal(percent(25, [{ price: 100 }]), 25);
});
