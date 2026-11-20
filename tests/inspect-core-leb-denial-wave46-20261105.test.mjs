import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const head = [0, 97, 115, 109, 1, 0, 0, 0];
const inspect = tail => inspectWasmBytes(Uint8Array.from([...head, ...tail]), {maxModuleBytes: 64});

test('core section lengths refuse padded, overlong and out-of-range LEB identities', () => {
  assert.equal(inspect([]).bytes.length, 8);
  // A custom section must encode a name; the empty name is a single zero byte.
  assert.equal(inspect([0, 1, 0]).bytes.length, 11);
  for (const [tail, reason] of [
    [[0, 0x80, 0], /noncanonical unsigned integer/],
    [[0, 0x80, 0x80, 0], /noncanonical unsigned integer/],
    [[0, 0xff, 0xff, 0xff, 0xff, 0x10], /invalid u32 encoding/],
    [[0, 0x80, 0x80, 0x80, 0x80, 0x80], /invalid u32 encoding/],
    [[0, 0x80], /truncated unsigned integer/],
    [[0, 5], /section extends beyond module/]
  ]) assert.throws(() => inspect(tail), reason, JSON.stringify(tail));
});

test('forbidden start and table sections are rejected before Wasm validation', () => {
  assert.throws(() => inspect([8, 0]), /start section is forbidden/);
  assert.throws(() => inspect([4, 0]), /table section is not yet admitted/);
});

test('snapshot inspection of a sliced DataView does not admit hostile outside bytes', () => {
  const backing = Uint8Array.from([255, ...head, 254]);
  const window = new DataView(backing.buffer, 1, head.length);
  const result = inspectWasmBytes(window, {maxModuleBytes: 8});
  assert.deepEqual([...result.bytes], head);
  backing.fill(0);
  assert.deepEqual([...result.bytes], head);
});
