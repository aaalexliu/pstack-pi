import assert from 'node:assert/strict';
import { test } from 'node:test';
import { total } from './m-tally.mjs';

test('total adds every price', () => {
  assert.equal(total([{ price: 1.5 }, { price: 2 }, { price: 0.5 }]), 4);
});
