import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const head = [0, 97, 115, 109, 1, 0, 0, 0];
const memory = (initial, maximum, flags = 1) => Uint8Array.from([
  ...head, 5, flags === 1 ? 4 : 3, 1, flags, initial,
  ...(flags === 1 ? [maximum] : [])
]);

test('fixed memory at exact default limit admits but one page above fails closed', () => {
  const atLimit = memory(32, 32);
  assert.equal(WebAssembly.validate(atLimit), true);
  const receipt = inspectWasmBytes(atLimit);
  assert.deepEqual({count: receipt.memoryCount, initial: receipt.memoryInitial, maximum: receipt.memoryMaximum},
    {count: 1, initial: 32, maximum: 32});
  assert.equal(receipt.hasMemoryMaximum, true);
  assert.throws(() => inspectWasmBytes(memory(33, 33)), /linear memory exceeds host budget/);
  assert.equal(inspectWasmBytes(memory(33, 33), {maxMemoryPages: 33}).memoryMaximum, 33);
});

test('invalid fixed ranges and omitted maximum are not admitted', () => {
  assert.throws(() => inspectWasmBytes(memory(5, 4)), /linear memory exceeds host budget/);
  const unbounded = Uint8Array.from([...head, 5, 3, 1, 0, 1]);
  assert.equal(WebAssembly.validate(unbounded), true);
  assert.throws(() => inspectWasmBytes(unbounded), /memory requires fixed initial and maximum/);
});

test('host page cap refuses invalid types and upper/lower out-of-policy values', () => {
  for (const invalid of [0, 257, -1, 2.5, Number.NaN, '32']) {
    assert.throws(() => inspectWasmBytes(memory(1, 1), {maxMemoryPages: invalid}), /invalid maximum memory pages/);
  }
});
