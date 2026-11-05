import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header = [0, 97, 115, 109, 1, 0, 0, 0];

test('invalid resource limits fail before reading untrusted module input', () => {
  let looked = 0;
  const input = {
    get buffer() { looked++; throw Error('untrusted buffer getter'); },
    get byteLength() { looked++; throw Error('untrusted length getter'); },
    get [Symbol.iterator]() { looked++; throw Error('untrusted iterator'); },
  };
  for (const options of [
    {maxModuleBytes: 7}, {maxModuleBytes: 16 * 1024 * 1024 + 1},
    {maxModuleBytes: '8'}, {maxModuleBytes: Number.NaN},
  ]) {
    assert.throws(() => inspectWasmBytes(input, options), /invalid maximum module size/);
  }
  for (const options of [
    {maxMemoryPages: 0}, {maxMemoryPages: 257},
    {maxMemoryPages: 1.5}, {maxMemoryPages: '32'},
  ]) {
    assert.throws(() => inspectWasmBytes(input, options), /invalid maximum memory pages/);
  }
  assert.equal(looked, 0);
});

test('sliced DataView is bounded by its own exact byte length and snapshotted', () => {
  const backing = new Uint8Array(32);
  const moduleBytes = [...header, 0, 1, 0];
  backing.set(moduleBytes, 9);
  const view = new DataView(backing.buffer, 9, moduleBytes.length);
  assert.equal(WebAssembly.validate(view), true);
  assert.throws(
    () => inspectWasmBytes(view, {maxModuleBytes: moduleBytes.length - 1}),
    /Wasm module exceeds maximum byte size/,
  );
  const receipt = inspectWasmBytes(view, {maxModuleBytes: moduleBytes.length});
  assert.deepEqual([...receipt.bytes], moduleBytes);
  backing.fill(0);
  assert.deepEqual([...receipt.bytes], moduleBytes);
  assert.equal(receipt.memoryCount, 0);
});
